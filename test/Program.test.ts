import { assert, describe, it } from "@effect/vitest";
import { type Cause, Effect, Layer, Logger, type LogLevel, Queue, References } from "effect";

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

const update = (overrides: Partial<VoiceStateUpdate>): VoiceStateUpdate => ({
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

// Runs the program over the given voice state updates until the queue ends, and
// returns what was posted to Slack and what was logged.
const runProgram = Effect.fnUntraced(function* (
  updates: ReadonlyArray<VoiceStateUpdate>,
  replies: ReadonlyArray<Reply> = [ok],
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
    Effect.provide(Layer.mergeAll(DiscordGateway.layerTest(queue), slack.layer, Logger.layer([captureLogs]))),
    withEnv(env),
  );

  return { posted: yield* slack.postedTexts, logs };
});

describe("program", () => {
  it.effect("1. announces a join from outside voice with name and join link", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: null })]);

      assert.deepStrictEqual(posted, [
        `🎙️ *Ada* joined the virtual office — <https://discord.com/channels/${GUILD}/${OFFICE}|join them>`,
      ]);
    }));

  it.effect("2. announces a move in from another voice channel", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: "lobby" })]);

      assert.strictEqual(posted.length, 1);
    }));

  it.effect("3. ignores mute, deafen and video changes inside the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: OFFICE, newChannelId: OFFICE })]);

      assert.deepStrictEqual(posted, []);
    }));

  it.effect("4. ignores bots joining the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ isBot: true })]);

      assert.deepStrictEqual(posted, []);
    }));

  it.effect("5. ignores joins to other voice channels", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ newChannelId: "lobby" })]);

      assert.deepStrictEqual(posted, []);
    }));

  it.effect("6. shows a display name with <, > and & literally without pinging", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ displayName: "<!channel> & <@U1>" })]);

      assert.include(posted[0], "*&lt;!channel&gt; &amp; &lt;@U1&gt;*");
      assert.notInclude(posted[0], "<!channel>");
    }));

  it.effect("8. logs a revoked webhook as an error and keeps handling joins", () =>
    Effect.gen(function* () {
      const { posted, logs } = yield* runProgram(
        [update({ userId: "u1" }), update({ userId: "u2", displayName: "Grace" })],
        [respond(404, "no_service"), ok],
      );

      assert.strictEqual(posted.length, 2);

      const failure = logs.find((entry) => entry.level === "Error");
      assert.strictEqual(failure?.message, "Slack rejected the post");
      assert.deepInclude(failure?.annotations, { reason: "WebhookRevoked", userId: "u1" });

      const success = logs.find((entry) => entry.message === "Announced office event");
      assert.deepInclude(success?.annotations, { event: "Joined", outcome: "posted", userId: "u2" });
    }));

  it.effect("announces disconnecting from the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: OFFICE, newChannelId: null })]);

      assert.deepStrictEqual(posted, ["👋 *Ada* left the virtual office"]);
    }));

  it.effect("announces moving out of the office to another voice channel", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: OFFICE, newChannelId: "lobby" })]);

      assert.deepStrictEqual(posted, ["👋 *Ada* left the virtual office"]);
    }));

  it.effect("ignores bots leaving the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: OFFICE, newChannelId: null, isBot: true })]);

      assert.deepStrictEqual(posted, []);
    }));

  it.effect("ignores leaving other voice channels", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: "lobby", newChannelId: null })]);

      assert.deepStrictEqual(posted, []);
    }));

  it.effect("posts joins and leaves in the order they arrive", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([
        update({ displayName: "Ada" }),
        update({ displayName: "Grace" }),
        update({ displayName: "Ada", oldChannelId: OFFICE, newChannelId: null }),
      ]);

      assert.strictEqual(posted.length, 3);
      assert.include(posted[0], "*Ada* joined");
      assert.include(posted[1], "*Grace* joined");
      assert.include(posted[2], "*Ada* left");
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
