import { assert, describe, it } from "@effect/vitest";
import { type Cause, Effect, Fiber, Layer, Logger, type LogLevel, Queue, References } from "effect";
import { TestClock } from "effect/testing";

import { DiscordGateway } from "../src/DiscordGateway.ts";
import { MainLayer, program } from "../src/Program.ts";
import { NO_VOICE_DETAILS, type VoiceStateUpdate } from "../src/OfficeEvent.ts";
import { firstVariant, hang, makeFakeRecorder, makeFakeSlack, ok, type Reply, respond, WEBHOOK_URL, withEnv } from "./fakes.ts";

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
  avatarUrl: "https://cdn.discordapp.com/avatars/u1/a.png",
  guildId: GUILD,
  oldChannelId: null,
  newChannelId: OFFICE,
  isBot: false,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
  ...overrides,
});

interface LogEntry {
  readonly level: LogLevel.LogLevel;
  readonly message: string;
  readonly annotations: Readonly<Record<string, string>>;
}

// Runs the program over the given voice state updates until the queue ends,
// starting with `present` already in the office, and returns what was posted
// to Slack, what was recorded and what was logged.
const runProgram = Effect.fnUntraced(function* (
  updates: ReadonlyArray<VoiceStateUpdate>,
  replies: ReadonlyArray<Reply> = [ok],
  present: ReadonlyArray<VoiceStateUpdate> = [],
) {
  const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();

  yield* Queue.offerAll(queue, updates);
  yield* Queue.end(queue);

  const slack = yield* makeFakeSlack(replies);
  const recorder = yield* makeFakeRecorder();
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
    Effect.provide(
      Layer.mergeAll(
        DiscordGateway.layerTest(queue, new Set(present.map((update) => update.userId)), GUILD, present),
        slack.layer,
        recorder.layer,
        Logger.layer([captureLogs]),
      ),
    ),
    withEnv(env),
    firstVariant,
  );

  return { posted: yield* slack.postedTexts, bodies: yield* slack.postedBodies, recorded: yield* recorder.recorded, logs };
});

const OPENED = "🎙️ *Ada* opened the virtual office — everyone's welcome to join!";

const EMPTIED = "🪑 The virtual office is empty right now — jump in and get it going!";

const leave = (overrides: Partial<VoiceStateUpdate> = {}) =>
  update({ oldChannelId: OFFICE, newChannelId: null, ...overrides });

describe("program", () => {
  it.effect("1. announces the first join from outside voice with name and join link", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: null })]);

      assert.deepStrictEqual(posted, [OPENED]);
    }));

  it.effect("posts a card with a join button and a recap when the office empties", () =>
    Effect.gen(function* () {
      const { bodies } = yield* runProgram([update(), update({ userId: "u2" }), leave({ userId: "u2" }), leave()]);

      const cards = JSON.stringify(bodies);
      assert.include(cards, `"url":"https://discord.com/channels/${GUILD}/${OFFICE}"`);
      assert.include(cards, `"image_url":"https://cdn.discordapp.com/avatars/u1/a.png"`);
      assert.include(cards, "*Stopped by*\\n2 people");
    }));

  it.effect("2. announces the office opening on a move in from another voice channel", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: "lobby" })]);

      assert.deepStrictEqual(posted, [OPENED]);
    }));

  it.effect("3. ignores mute, deafen and video changes inside the office", () =>
    Effect.gen(function* () {
      const { posted } = yield* runProgram([update({ oldChannelId: OFFICE, newChannelId: OFFICE })], [ok], [update()]);

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
      assert.deepInclude(failure?.annotations, { reason: "WebhookRevoked", event: "Opened", userId: "<redacted>" });

      const success = logs.find((entry) => entry.message === "Announced office event");
      assert.deepInclude(success?.annotations, { event: "Emptied", outcome: "posted", userId: "<redacted>" });
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
        [update()],
      );

      assert.deepStrictEqual(posted, [EMPTIED]);
    }));
});

describe("recording", () => {
  it.effect("records who was already there, then every update touching the office", () =>
    Effect.gen(function* () {
      const { recorded } = yield* runProgram(
        [
          update({ userId: "u2", displayName: "Grace" }),
          update({ userId: "u2", oldChannelId: OFFICE, newChannelId: OFFICE }),
          update({ userId: "u3", newChannelId: "lobby" }),
          update({ userId: "bot", isBot: true }),
          leave({ userId: "u2", newChannelId: "lobby" }),
        ],
        [ok],
        [update()],
      );

      assert.deepStrictEqual(
        recorded.map(({ source, userId, oldChannelId, newChannelId }) => ({
          source,
          userId,
          oldChannelId,
          newChannelId,
        })),
        [
          { source: "startup", userId: "u1", oldChannelId: null, newChannelId: OFFICE },
          { source: "update", userId: "u2", oldChannelId: null, newChannelId: OFFICE },
          { source: "update", userId: "u2", oldChannelId: OFFICE, newChannelId: OFFICE },
          { source: "update", userId: "u2", oldChannelId: OFFICE, newChannelId: "lobby" },
        ],
      );
    }));

  it.effect("keeps recording while a Slack post is being retried", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      const slack = yield* makeFakeSlack([hang]);
      const recorder = yield* makeFakeRecorder();

      const fiber = yield* program.pipe(
        Effect.provide(Layer.mergeAll(DiscordGateway.layerTest(queue), slack.layer, recorder.layer)),
        withEnv(env),
        firstVariant,
        Effect.forkChild,
      );

      // The first post never answers, so the office events stall behind it.
      yield* Queue.offerAll(queue, [update(), leave(), update()]);

      while ((yield* recorder.recorded).length < 3) {
        yield* Effect.yieldNow;
      }

      yield* Fiber.interrupt(fiber);
    }));
});

describe("daily reminder", () => {
  it.effect("posts the reminder to Slack while watching the office", () =>
    Effect.gen(function* () {
      const queue = yield* Queue.unbounded<VoiceStateUpdate, Cause.Done>();
      const slack = yield* makeFakeSlack([ok]);
      const recorder = yield* makeFakeRecorder();

      const fiber = yield* program.pipe(
        Effect.provide(Layer.mergeAll(DiscordGateway.layerTest(queue), slack.layer, recorder.layer)),
        withEnv(env),
        firstVariant,
        Effect.forkChild,
      );

      // The test clock starts on a Thursday, so the first reminder is at 09:15Z.
      yield* TestClock.adjust("10 hours");
      yield* Queue.end(queue);
      yield* Fiber.join(fiber);

      // Reminders rotate by date, and that Thursday picks the fourth phrasing.
      assert.deepStrictEqual(yield* slack.postedTexts, [
        "🪴 The office plant is lonely. It's been talking to itself again. Come keep it company!",
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
