import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient } from "effect/sql";

import { ActivityLog } from "../src/ActivityLog.ts";
import { columnNaming, Database } from "../src/Database.ts";
import { NO_VOICE_DETAILS, type VoiceDetails } from "../src/OfficeEvent.ts";
import { MAX_ACTIVITY_ENTRIES, OfficeHistory } from "../src/OfficeHistory.ts";
import type { VoiceObservation } from "../src/VoiceObservation.ts";

const OFFICE = "office";

const EARLIER_SESSION = "0b8f8a52-61a4-4b8e-9a43-2f7d0f2f6a01";

const SESSION = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

// In-process Postgres with the real migrations.
const TestLayer = Layer.mergeAll(OfficeHistory.layer, ActivityLog.layer).pipe(
  Layer.provideMerge(Database.layerNoDeps()),
  Layer.provideMerge(PgliteClient.layer(columnNaming)),
);

const minutes = (minute: number) => DateTime.makeUnsafe(minute * 60_000);

const inVoice = (overrides: Partial<VoiceDetails> = {}): VoiceDetails => ({
  ...NO_VOICE_DETAILS,
  selfMute: false,
  selfDeaf: false,
  selfVideo: false,
  streaming: false,
  ...overrides,
});

const observation = (
  minute: number,
  userId: string,
  displayName: string,
  overrides: Partial<VoiceObservation> = {},
): VoiceObservation => ({
  source: "update",
  officeChannelId: OFFICE,
  userId,
  displayName,
  avatarUrl: null,
  guildId: "g1",
  isBot: false,
  oldChannelId: OFFICE,
  newChannelId: OFFICE,
  oldDetails: inVoice(),
  newDetails: inVoice(),
  at: minutes(minute),
  ...overrides,
});

const joins = (minute: number, userId: string, displayName: string) =>
  observation(minute, userId, displayName, { oldChannelId: null, oldDetails: NO_VOICE_DETAILS });

const leaves = (minute: number, userId: string, displayName: string) =>
  observation(minute, userId, displayName, { newChannelId: null, newDetails: NO_VOICE_DETAILS });

const record = Effect.fnUntraced(function* (session: string, ...observations: ReadonlyArray<VoiceObservation>) {
  const log = yield* ActivityLog;

  yield* Effect.forEach(observations, (seen) => log.record(session, crypto.randomUUID(), seen), { discard: true });
});

const startSessions = Effect.gen(function* () {
  const database = yield* Database;
  const log = yield* ActivityLog;

  yield* database.ready;
  yield* log.startSession(EARLIER_SESSION, minutes(0));
  yield* log.startSession(SESSION, minutes(100));
});

describe("OfficeHistory", () => {
  it.effect("reads what happened in a period, oldest first, with real names when they're filled in", () =>
    Effect.gen(function* () {
      yield* startSessions;
      yield* record(
        SESSION,
        joins(101, "u1", "Ada"),
        observation(102, "u1", "Ada", { newDetails: inVoice({ selfVideo: true }) }),
        joins(103, "u2", "Grace"),
        leaves(110, "u1", "Ada"),
      );

      const sql = yield* SqlClient.SqlClient;

      yield* sql`UPDATE office.members SET real_name = 'Grace Hopper' WHERE user_id = 'u2'`;

      const history = yield* OfficeHistory;
      const activity = yield* history.latestActivityBetween(minutes(102), minutes(110));

      assert.deepStrictEqual(activity, {
        entriesOldestFirst: [
          { at: minutes(102), who: "Ada", event: "CameraOn" },
          { at: minutes(103), who: "Grace Hopper", event: "Joined" },
        ],
        olderEntriesLeftOut: 0,
      });
    }).pipe(Effect.provide(TestLayer)));

  it.effect(`keeps the latest ${MAX_ACTIVITY_ENTRIES} entries of a busy period and counts the rest`, () =>
    Effect.gen(function* () {
      yield* startSessions;

      const toggles = Array.from({ length: MAX_ACTIVITY_ENTRIES + 5 }, (_, index) =>
        observation(200 + index, "u1", "Ada", {
          oldDetails: inVoice({ selfMute: index % 2 === 1 }),
          newDetails: inVoice({ selfMute: index % 2 === 0 }),
        }),
      );

      yield* record(SESSION, ...toggles);

      const history = yield* OfficeHistory;
      const { entriesOldestFirst, olderEntriesLeftOut } = yield* history.latestActivityBetween(minutes(0), minutes(10_000));

      assert.strictEqual(entriesOldestFirst.length, MAX_ACTIVITY_ENTRIES);
      assert.strictEqual(olderEntriesLeftOut, 5);
      assert.deepStrictEqual(entriesOldestFirst.at(-1)?.at, minutes(200 + MAX_ACTIVITY_ENTRIES + 4));
    }).pipe(Effect.provide(TestLayer)));

  it.effect("knows who's in the office from what the latest run of the bot recorded", () =>
    Effect.gen(function* () {
      yield* startSessions;
      yield* record(EARLIER_SESSION, joins(10, "u3", "Linus"));
      yield* record(
        SESSION,
        observation(101, "u1", "Ada", { source: "startup", oldChannelId: null, oldDetails: NO_VOICE_DETAILS }),
        joins(102, "u2", "Grace"),
        observation(103, "u2", "Grace", { newDetails: inVoice({ selfMute: true }) }),
        joins(104, "u4", "Alan"),
        leaves(105, "u4", "Alan"),
      );

      const history = yield* OfficeHistory;

      assert.deepStrictEqual(yield* history.presentSinceBotStarted, ["Ada", "Grace"]);
    }).pipe(Effect.provide(TestLayer)));

  it.effect("counts the banter posted since a given time", () =>
    Effect.gen(function* () {
      yield* startSessions;

      const history = yield* OfficeHistory;

      yield* history.recordBanterPost(minutes(10), "Today");
      yield* history.recordBanterPost(minutes(20), "LastWeek");
      yield* history.recordBanterPost(minutes(30), "ThisWeek");

      assert.strictEqual(yield* history.banterPostsSince(minutes(20)), 2);
    }).pipe(Effect.provide(TestLayer)));

  it.effect("fails every read when nothing is recorded", () =>
    Effect.gen(function* () {
      const history = yield* OfficeHistory;

      const error = yield* Effect.flip(history.banterPostsSince(minutes(0)));

      assert.strictEqual(error._tag, "HistoryUnavailable");
    }).pipe(Effect.provide(OfficeHistory.layerDisabled)));
});
