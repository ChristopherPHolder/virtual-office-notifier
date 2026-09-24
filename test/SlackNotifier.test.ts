import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Fiber, Layer, Ref } from "effect";
import { TestClock } from "effect/testing";
import {
  HttpBody,
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http";

import {
  InvalidPayload,
  SlackNotifier,
  Transport,
  Unavailable,
  WebhookRevoked,
} from "../src/SlackNotifier.ts";
import type { VoiceJoin } from "../src/VoiceJoin.ts";

const WEBHOOK_URL = "https://hooks.slack.com/services/TEST/WEBHOOK/secret";

const join: VoiceJoin = {
  userId: "u1",
  displayName: "Ada",
  guildId: "g1",
  channelId: "c1",
};

type Reply = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>;

const respond =
  (status: number, body: string, headers: Record<string, string> = {}): Reply =>
  (request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, new Response(body, { status, headers })));

const ok = respond(200, "ok");

const networkDown: Reply = (request) =>
  Effect.fail(
    new HttpClientError.HttpClientError({
      reason: new HttpClientError.TransportError({
        request,
        description: "connect ECONNREFUSED",
      }),
    }),
  );

const hang: Reply = () => Effect.never;

const requestText = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body instanceof HttpBody.Uint8Array ? new TextDecoder().decode(request.body.body) : "";

// Serves the scripted replies in order, repeating the last one, and records
// every request so tests can count attempts.
const makeSlack = Effect.fnUntraced(function* (replies: ReadonlyArray<Reply>) {
  const requests = yield* Ref.make<ReadonlyArray<HttpClientRequest.HttpClientRequest>>([]);

  const client = HttpClient.make((request) =>
    Ref.modify(requests, (sent) => [sent.length, [...sent, request]]).pipe(
      Effect.flatMap((index) => (replies[index] ?? replies.at(-1) ?? ok)(request)),
    ),
  );

  const layer = SlackNotifier.layerNoDeps.pipe(
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env: { SLACK_WEBHOOK_URL: WEBHOOK_URL } }))),
  );

  const notifier = yield* Effect.service(SlackNotifier).pipe(Effect.provide(layer));

  return { notifier, requests: Ref.get(requests) };
});

describe("SlackNotifier", () => {
  it.effect("posts the formatted message to the webhook", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([ok]);

      yield* slack.notifier.notify(join);

      const requests = yield* slack.requests;
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.url, WEBHOOK_URL);
      assert.deepStrictEqual(JSON.parse(requestText(requests[0]!)), {
        text: "🎙️ *Ada* joined the virtual office — <https://discord.com/channels/g1/c1|join them>",
      });
    }));

  it.effect("fails without retrying when the webhook is revoked", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(404, "no_service")]);

      const { reason } = yield* slack.notifier.notify(join).pipe(Effect.flip);

      assert.instanceOf(reason, WebhookRevoked);
      assert.strictEqual(reason.status, 404);
      assert.strictEqual(reason.body, "no_service");
      assert.strictEqual((yield* slack.requests).length, 1);
    }));

  it.effect("fails without retrying on an invalid payload", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(400, "invalid_payload")]);

      const { reason } = yield* slack.notifier.notify(join).pipe(Effect.flip);

      assert.instanceOf(reason, InvalidPayload);
      assert.strictEqual((yield* slack.requests).length, 1);
    }));

  it.effect("waits for Retry-After when rate limited, then succeeds", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(429, "", { "retry-after": "5" }), ok]);

      const fiber = yield* slack.notifier.notify(join).pipe(Effect.forkChild);

      yield* TestClock.adjust("4 seconds");
      assert.strictEqual((yield* slack.requests).length, 1);

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.strictEqual((yield* slack.requests).length, 2);
    }));

  it.effect("gives up after 4 retries when Slack stays unavailable", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(503, "")]);

      const fiber = yield* slack.notifier.notify(join).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      const { reason } = yield* Fiber.join(fiber);

      assert.instanceOf(reason, Unavailable);
      assert.strictEqual(reason.status, 503);
      assert.strictEqual((yield* slack.requests).length, 5);
    }));

  it.effect("backs off exponentially from 1 second", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(503, "")]);

      yield* slack.notifier.notify(join).pipe(Effect.ignore, Effect.forkChild);

      // Jitter keeps the first delay within 0.8s-1.2s.
      yield* TestClock.adjust("790 millis");
      assert.strictEqual((yield* slack.requests).length, 1);

      yield* TestClock.adjust("420 millis");
      assert.strictEqual((yield* slack.requests).length, 2);
    }));

  it.effect("retries network errors without leaking the webhook URL", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([networkDown, ok]);

      const fiber = yield* slack.notifier.notify(join).pipe(Effect.forkChild);

      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);
      assert.strictEqual((yield* slack.requests).length, 2);

      const failed = yield* makeSlack([networkDown]);
      const failedFiber = yield* failed.notifier.notify(join).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(failedFiber);

      assert.instanceOf(error.reason, Transport);
      assert.include(error.reason.cause, "ECONNREFUSED");
      assert.notInclude(`${error} ${JSON.stringify(error)}`, "secret");
    }));

  it.effect("times out an attempt after 10 seconds", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([hang, ok]);

      const fiber = yield* slack.notifier.notify(join).pipe(Effect.forkChild);

      yield* TestClock.adjust("9 seconds");
      assert.strictEqual((yield* slack.requests).length, 1);

      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(fiber);
      assert.strictEqual((yield* slack.requests).length, 2);
    }));
});
