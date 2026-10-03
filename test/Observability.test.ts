import * as Sentry from "@sentry/effect/server";
import { assert, describe, it } from "@effect/vitest";
import { type Cause, Effect, Fiber, Layer, Queue } from "effect";
import { TestClock } from "effect/testing";

import { ActivityRecorder } from "../src/ActivityRecorder.ts";
import { DiscordGateway } from "../src/DiscordGateway.ts";
import { layerSentry } from "../src/Observability.ts";
import { NO_VOICE_DETAILS, type VoiceStateUpdate } from "../src/OfficeEvent.ts";
import { OfficeHistory } from "../src/OfficeHistory.ts";
import { program } from "../src/Program.ts";
import { firstVariant, makeFakeSlack, ok, type Reply, respond, WEBHOOK_URL, withEnv } from "./fakes.ts";

const OFFICE = "office";

const env = {
  DISCORD_BOT_TOKEN: "discord-token",
  DISCORD_OFFICE_CHANNEL_ID: OFFICE,
  SLACK_WEBHOOK_URL: WEBHOOK_URL,
};

const join: VoiceStateUpdate = {
  userId: "u1",
  displayName: "Ada",
  avatarUrl: null,
  guildId: "guild",
  oldChannelId: null,
  newChannelId: OFFICE,
  isBot: false,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
};

// Runs the program with Sentry pointed at a transport that sends nothing, and
// returns the errors, logs and spans it would have sent.
const runWithSentry = Effect.fnUntraced(function* (replies: ReadonlyArray<Reply>) {
  const events: Array<Sentry.ErrorEvent> = [];
  const logs: Array<Sentry.Log> = [];
  const spans: Array<ReturnType<typeof Sentry.spanToJSON>> = [];

  const sentry = layerSentry({
    dsn: "https://public@o0.ingest.sentry.io/0",
    tracesSampleRate: 1,
    transport: (options) => Sentry.createTransport(options, () => Promise.resolve({})),
    beforeSend: (event) => {
      events.push(event);

      return null;
    },
    beforeSendLog: (log) => {
      logs.push(log);

      return null;
    },
  });

  const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
  const slack = yield* makeFakeSlack(replies);

  yield* Effect.gen(function* () {
    Sentry.getClient()?.on("spanEnd", (span) => {
      spans.push(Sentry.spanToJSON(span));
    });

    yield* Queue.offer(queue, join);
    yield* Queue.end(queue);

    const fiber = yield* program.pipe(
      Effect.provide(Layer.mergeAll(DiscordGateway.layerTest(queue), slack.layer, ActivityRecorder.layerDisabled, OfficeHistory.layerDisabled)),
      Effect.forkChild,
    );

    // Lets every retry run.
    yield* TestClock.adjust("1 minute");
    yield* Fiber.join(fiber);
  }).pipe(Effect.provide(sentry), withEnv(env), firstVariant);

  return { events, logs, spans };
});

describe("Sentry", () => {
  it.effect("traces each announcement without the webhook URL", () =>
    Effect.gen(function* () {
      const { spans } = yield* runWithSentry([ok]);

      const announce = spans.find((span) => span.name === "Program.announce");
      assert.isTrue(announce?.is_segment);
      assert.strictEqual(announce?.attributes["event"], "Opened");
      assert.includeMembers(
        spans.map((span) => span.name),
        ["Program.announce", "SlackNotifier.notify", "SlackNotifier.post"],
      );
      assert.isTrue(spans.every((span) => span.trace_id === announce?.trace_id));
      assert.notInclude(JSON.stringify(spans), WEBHOOK_URL);
    }));

  it.effect("sends logs, linked to the announcement's trace", () =>
    Effect.gen(function* () {
      const { logs, spans } = yield* runWithSentry([ok]);

      const announced = logs.find((log) => log.message === "Announced office event");
      const announce = spans.find((span) => span.name === "Program.announce");
      assert.strictEqual(announced?.level, "info");
      assert.strictEqual(announced?.attributes?.["sentry.trace.parent_span_id"], announce?.span_id);
    }));

  it.effect("reports a revoked webhook as an error", () =>
    Effect.gen(function* () {
      const { events } = yield* runWithSentry([respond(404, "no_service")]);

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.level, "error");
      assert.strictEqual(events[0]?.exception?.values?.[0]?.value, "Slack rejected the post: WebhookRevoked");
      assert.deepStrictEqual(events[0]?.extra, { reason: "WebhookRevoked" });
      assert.notInclude(JSON.stringify(events), WEBHOOK_URL);
    }));

  it.effect("reports giving up after retries as a warning", () =>
    Effect.gen(function* () {
      const { events } = yield* runWithSentry([respond(503, "down")]);

      assert.strictEqual(events.length, 1);
      assert.strictEqual(events[0]?.level, "warning");
      assert.strictEqual(events[0]?.exception?.values?.[0]?.value, "Gave up posting to Slack after retries: Unavailable");
    }));
});
