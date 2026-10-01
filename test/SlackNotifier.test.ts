import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Random } from "effect";
import { TestClock } from "effect/testing";

import { HeadlineWriter } from "../src/HeadlineWriter.ts";
import {
  InvalidPayload,
  SlackNotifier,
  Transport,
  Unavailable,
  WebhookRevoked,
} from "../src/SlackNotifier.ts";
import { formatMessage } from "../src/SlackMessage.ts";
import {
  firstVariant,
  hang,
  makeFakeSlack,
  networkDown,
  opened,
  ok,
  type Reply,
  requestText,
  respond,
  WEBHOOK_URL,
  withEnv,
} from "./fakes.ts";

const makeSlack = Effect.fnUntraced(function* (
  replies: ReadonlyArray<Reply>,
  headlines?: Layer.Layer<HeadlineWriter>,
) {
  const fake = yield* makeFakeSlack(replies, headlines);

  const notifier = yield* Effect.service(SlackNotifier).pipe(
    Effect.provide(fake.layer),
    withEnv({ SLACK_WEBHOOK_URL: WEBHOOK_URL }),
  );

  return { notifier, requests: fake.requests };
});

describe("SlackNotifier", () => {
  it.effect("posts the formatted message to the webhook", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([ok]);

      yield* slack.notifier.notify(opened).pipe(firstVariant);

      const requests = yield* slack.requests;
      assert.strictEqual(requests.length, 1);
      assert.strictEqual(requests[0]?.url, WEBHOOK_URL);
      assert.deepStrictEqual(JSON.parse(requestText(requests[0]!)), formatMessage(opened, 0));
    }));

  it.effect("posts a generated headline when the office opens", () =>
    Effect.gen(function* () {
      const generated = Layer.succeed(
        HeadlineWriter,
        HeadlineWriter.of({
          write: () => Effect.succeedSome({ template: "🛋️ {name} saved you a seat!", button: "🪑 Grab a seat", model: "test/model" }),
        }),
      );

      const slack = yield* makeSlack([ok], generated);

      yield* slack.notifier.notify(opened);

      const [request] = yield* slack.requests;
      assert.strictEqual(JSON.parse(requestText(request!)).text, "🛋️ *Ada* saved you a seat!");
    }));

  it.effect("posts the same wording on every retry", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(503, ""), ok]);

      const fiber = yield* slack.notifier.notify(opened).pipe(Random.withSeed("retry"), Effect.forkChild);

      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);

      const [first, second] = (yield* slack.requests).map(requestText);
      assert.strictEqual(first, second);
    }));

  it.effect("fails without retrying when the webhook is revoked", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(404, "no_service")]);

      const { reason } = yield* slack.notifier.notify(opened).pipe(Effect.flip);

      assert.instanceOf(reason, WebhookRevoked);
      assert.strictEqual(reason.status, 404);
      assert.strictEqual(reason.body, "no_service");
      assert.strictEqual((yield* slack.requests).length, 1);
    }));

  it.effect("fails without retrying on an invalid payload", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(400, "invalid_payload")]);

      const { reason } = yield* slack.notifier.notify(opened).pipe(Effect.flip);

      assert.instanceOf(reason, InvalidPayload);
      assert.strictEqual((yield* slack.requests).length, 1);
    }));

  it.effect("waits for Retry-After when rate limited, then succeeds", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(429, "", { "retry-after": "5" }), ok]);

      const fiber = yield* slack.notifier.notify(opened).pipe(Effect.forkChild);

      yield* TestClock.adjust("4 seconds");
      assert.strictEqual((yield* slack.requests).length, 1);

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(fiber);
      assert.strictEqual((yield* slack.requests).length, 2);
    }));

  it.effect("gives up after 4 retries when Slack stays unavailable", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(503, "")]);

      const fiber = yield* slack.notifier.notify(opened).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      const { reason } = yield* Fiber.join(fiber);

      assert.instanceOf(reason, Unavailable);
      assert.strictEqual(reason.status, 503);
      assert.strictEqual((yield* slack.requests).length, 5);
    }));

  it.effect("backs off exponentially from 1 second", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([respond(503, "")]);

      yield* slack.notifier.notify(opened).pipe(Effect.ignore, Effect.forkChild);

      // Jitter keeps the first delay within 0.8s-1.2s.
      yield* TestClock.adjust("790 millis");
      assert.strictEqual((yield* slack.requests).length, 1);

      yield* TestClock.adjust("420 millis");
      assert.strictEqual((yield* slack.requests).length, 2);
    }));

  it.effect("retries network errors without leaking the webhook URL", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([networkDown, ok]);

      const fiber = yield* slack.notifier.notify(opened).pipe(Effect.forkChild);

      yield* TestClock.adjust("2 seconds");
      yield* Fiber.join(fiber);
      assert.strictEqual((yield* slack.requests).length, 2);

      const failed = yield* makeSlack([networkDown]);
      const failedFiber = yield* failed.notifier.notify(opened).pipe(Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("1 minute");
      const error = yield* Fiber.join(failedFiber);

      assert.instanceOf(error.reason, Transport);
      assert.include(error.reason.cause, "ECONNREFUSED");
      assert.notInclude(`${error} ${JSON.stringify(error)}`, "secret");
    }));

  it.effect("times out an attempt after 10 seconds", () =>
    Effect.gen(function* () {
      const slack = yield* makeSlack([hang, ok]);

      const fiber = yield* slack.notifier.notify(opened).pipe(Effect.forkChild);

      yield* TestClock.adjust("9 seconds");
      assert.strictEqual((yield* slack.requests).length, 1);

      yield* TestClock.adjust("3 seconds");
      yield* Fiber.join(fiber);
      assert.strictEqual((yield* slack.requests).length, 2);
    }));
});
