import { assert, describe, it } from "@effect/vitest";
import { type Cause, Effect, Fiber, Layer, Logger, type LogLevel, Queue, References } from "effect";
import { TestClock } from "effect/testing";

import { DiscordGateway } from "../src/DiscordGateway.ts";
import { MainLayer, program } from "../src/Program.ts";
import type { VoiceStateUpdate } from "../src/OfficeEvent.ts";
import { makeFakeSlack, ok, type Reply, respond, WEBHOOK_URL, withEnv } from "./fakes.ts";

const OFFICE = "office";

const GUILD = "guild";

const env = {
  DISCORD_BOT_TOKEN: "discord-token",
  DISCORD_OFFICE_CHANNEL_ID: OFFICE,
  SLACK_WEBHOOK_URL: WEBHOOK_URL,
};

const update = (overrides: Partial<VoiceStateUpdate> = {}): VoiceStateUpdate => ({
  userId: "u1",
  displayName: "Ada",
  guildId: GUILD,
  oldChannelId: null,
  newChannelId: OFFICE,
  isBot: false,
  ...overrides,
});

interface LogEntry {
  readonly level: LogLevel.LogLevel;
  readonly message: string;
  readonly annotations: Readonly<Record<string, string>>;
}

// Runs the program over the given voice state updates until the queue ends,
// starting with `occupants` already in the office, and returns what was posted
// to Slack and what was logged.
const runProgram = Effect.fnUntraced(function* (
  updates: ReadonlyArray<VoiceStateUpdate>,
  replies: ReadonlyArray<Reply> = [ok],
  occupants: ReadonlyArray<string> = [],
) {
  const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();

  yield* Queue.offerAll(queue, updates);
  yield* Queue.end(queue);

  const slack = yield* makeFakeSlack(replies);
  const logs: Array<LogEntry> = [];

  const captureLogs = Logger.make<unknown, void>((options) => {
    logs.push({
      level: options.logLevel,
      message: String(Array.isArray(options.message) ? options.message[0] : options.message),
      annotations: Object.fromEntries(
        Object.entries(options.fiber.getRef(References.CurrentLogAnnotations)).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    });
  });

  yield* program.pipe(
    Effect.provide(Layer.mergeAll(DiscordGateway.layerTest(queue, new Set(occupants)), slack.layer, Logger.layer([captureLogs]))),
    withEnv(env),
  );

  return { posted: yield* slack.postedTexts, logs };
});

const OPENED = `🎙️ *Ada* opened the virtual office — everyone's welcome to <https://discord.com/channels/${GUILD}/${OFFICE}|join>!`;

const EMPTIED = `🪑 The virtual office is empty right now — <https://discord.com/channels/${GUILD}/${OFFICE}|jump in> and get it going!`;

const leave = (overrides: Partial<VoiceStateUpdate> = {}) =>
  update({ oldChannelId: OFFICE, newChannelId: null, ...overrides });

describe("program", () => {
  it.effect("1. announces the first join from outside voice with name and join link", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: null })]);

      assert.deepStrictEqual(posted, [OPENED]);
    }));

  it.effect("2. announces the office opening on a move in from another voice channel", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: "lobby" })]);

      assert.deepStrictEqual(posted, [OPENED]);
    }));

  it.effect("3. ignores mute, deafen and video changes inside the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: OFFICE, newChannelId: OFFICE })], [ok], ["u1"]);

      assert.deepStrictEqual(posted, []);
    }));

  it.effect("4. ignores bots joining and leaving the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ isBot: true }), leave({ isBot: true })]);

      assert.deepStrictEqual(posted, []);
    }));

  it.effect("5. ignores other voice channels", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([
        update({ newChannelId: "lobby" }),
        update({ oldChannelId: "lobby", newChannelId: null }),
      ]);

      assert.deepStrictEqual(posted, []);
    }));

  it.effect("6. shows a display name with <, > and & literally without pinging", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ displayName: "<!channel> & <@U1>" })]);

      assert.include(posted[0], "*&lt;!channel&gt; &amp; &lt;@U1&gt;*");
      assert.notInclude(posted[0], "<!channel>");
    }));

  it.effect("7. only announces the office opening and emptying, not everyone in between", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([
        update({ userId: "u1", displayName: "Ada" }),
        update({ userId: "u2", displayName: "Grace" }),
        leave({ userId: "u1", displayName: "Ada" }),
        update({ userId: "u3", displayName: "Linus" }),
        leave({ userId: "u2", displayName: "Grace" }),
        leave({ userId: "u3", displayName: "Linus", newChannelId: "lobby" }),
      ]);

      assert.deepStrictEqual(posted, [OPENED, EMPTIED]);
    }));

  it.effect("8. logs a revoked webhook as an error and keeps handling events", () =>
    Effect.gen(function* () {
      const { posted, logs } = yield* runProgram([update(), leave()], [respond(404, "no_service"), ok]);

      assert.strictEqual(posted.length, 2);

      const failure = logs.find((entry) => entry.level === "Error");
      assert.strictEqual(failure?.message, "Slack rejected the post");
      assert.deepInclude(failure?.annotations, { reason: "WebhookRevoked", event: "Opened", userId: "u1" });

      const success = logs.find((entry) => entry.message === "Announced office event");
      assert.deepInclude(success?.annotations, { event: "Emptied", outcome: "posted", userId: "u1" });
    }));

  it.effect("reopens the office after it emptied", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update(), leave(), update()]);

      assert.deepStrictEqual(posted, [OPENED, EMPTIED, OPENED]);
    }));

  it.effect("doesn't announce opening when people were already in the office at startup", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram(
        [update({ userId: "u2", displayName: "Grace" }), leave({ userId: "u2" }), leave({ userId: "u1" })],
        [ok],
        ["u1"],
      );

      assert.deepStrictEqual(posted, [EMPTIED]);
    }));
});

describe("daily reminder", () => {
  it.effect("posts the reminder to Slack while watching the office", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      const slack = yield* makeFakeSlack([ok]);

      const fiber = yield* program.pipe(
        Effect.provide(Layer.merge(DiscordGateway.layerTest(queue), slack.layer)),
        withEnv(env),
        Effect.forkChild,
      );

      // The test clock starts on a Thursday, so the first reminder is at 09:15Z.
      yield* TestClock.adjust("10 hours");
      yield* Queue.end(queue);
      yield* Fiber.join(fiber);

      assert.deepStrictEqual(yield* slack.postedTexts, [
        `⏰ Daily reminder: come hang out in the virtual office — <https://discord.com/channels/${GUILD}/${OFFICE}|join> us!`,
      ]);
    }));
});

describe("MainLayer", () => {
  const { SLACK_WEBHOOK_URL: _slack, ...withoutSlack } = env;
  const { DISCORD_OFFICE_CHANNEL_ID: _office, ...withoutOffice } = env;

  it.effect.each([
    { missing: "SLACK_WEBHOOK_URL", env: withoutSlack },
    { missing: "DISCORD_OFFICE_CHANNEL_ID", env: withoutOffice },
  ])("9. fails at startup naming a missing $missing", ({ missing, env }) =>
    Effect.gen(function* () {
      const error = yield* Layer.build(MainLayer).pipe(Effect.scoped, withEnv(env), Effect.flip);

      assert.include(String(error), missing);
    }));
});
