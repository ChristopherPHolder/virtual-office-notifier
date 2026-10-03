import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Effect, Layer } from "effect";
import { SqlClient, SqlError } from "effect/sql";

import { ActivityLog, BadRow, classify, Outage } from "../src/ActivityLog.ts";
import { columnNaming, Database } from "../src/Database.ts";
import { NO_VOICE_DETAILS, type VoiceDetails } from "../src/OfficeEvent.ts";
import type { VoiceObservation } from "../src/VoiceObservation.ts";

const OFFICE = "office";

const SESSION = "6f1c2c1e-6c1a-4c55-9a0e-8e3b8f9b2a10";

// In-process Postgres with the real migrations.
const TestLayer = ActivityLog.layer.pipe(
  Layer.provideMerge(Database.layerNoDeps()),
  Layer.provideMerge(PgliteClient.layer(columnNaming)),
);

const inVoice = (overrides: Partial<VoiceDetails> = {}): VoiceDetails => ({
  selfMute: false,
  selfDeaf: false,
  serverMute: false,
  serverDeaf: false,
  selfVideo: false,
  streaming: false,
  suppress: false,
  requestToSpeakAt: null,
  sessionId: "voice-session",
  ...overrides,
});

const observation = (minute: number, overrides: Partial<VoiceObservation> = {}): VoiceObservation => ({
  source: "update",
  officeChannelId: OFFICE,
  userId: "u1",
  displayName: "Ada",
  avatarUrl: null,
  guildId: "g1",
  isBot: false,
  oldChannelId: OFFICE,
  newChannelId: OFFICE,
  oldDetails: inVoice(),
  newDetails: inVoice(),
  at: DateTime.makeUnsafe(minute * 60_000),
  ...overrides,
});

const joined = (minute: number, details: VoiceDetails = inVoice()) =>
  observation(minute, { oldChannelId: null, oldDetails: NO_VOICE_DETAILS, newDetails: details });

const ready = Effect.gen(function* () {
  const database = yield* Database;

  yield* database.ready;
});

describe("ActivityLog", () => {
  it.effect("records the snapshot as Discord sent it, with its member", () =>
    Effect.gen(function* () {
      yield* ready;

      const log = yield* ActivityLog;
      const sql = yield* SqlClient.SqlClient;

      yield* log.startSession(SESSION, DateTime.makeUnsafe(0));
      yield* log.record(SESSION, crypto.randomUUID(), joined(1, inVoice({ selfMute: true, requestToSpeakAt: DateTime.makeUnsafe(5) })));

      const [snapshot] = yield* sql`SELECT * FROM office.voice_snapshots`;
      const [member] = yield* sql`SELECT * FROM office.members`;

      assert.deepInclude(snapshot, {
        botSessionId: SESSION,
        source: "update",
        guildId: "g1",
        officeChannelId: OFFICE,
        userId: "u1",
        oldChannelId: null,
        newChannelId: OFFICE,
        oldSelfMute: null,
        newSelfMute: true,
        newSelfDeaf: false,
        newSessionId: "voice-session",
      });
      assert.instanceOf(snapshot?.["observedAt"], Date);
      assert.deepInclude(member, { userId: "u1", displayName: "Ada", realName: null });
    }).pipe(Effect.provide(TestLayer)));

  it.effect("keeps a real name filled in by hand while updating the display name", () =>
    Effect.gen(function* () {
      yield* ready;

      const log = yield* ActivityLog;
      const sql = yield* SqlClient.SqlClient;

      yield* log.startSession(SESSION, DateTime.makeUnsafe(0));
      yield* log.record(SESSION, crypto.randomUUID(), joined(1));
      yield* sql`UPDATE office.members SET real_name = 'Ada Lovelace' WHERE user_id = 'u1'`;
      yield* log.record(SESSION, crypto.randomUUID(), observation(2, { displayName: "Ada L." }));

      const [member] = yield* sql<{
        readonly displayName: string;
        readonly realName: string;
        readonly firstSeenAt: Date;
        readonly lastSeenAt: Date;
      }>`SELECT display_name, real_name, first_seen_at, last_seen_at FROM office.members`;

      assert.strictEqual(member?.displayName, "Ada L.");
      assert.strictEqual(member?.realName, "Ada Lovelace");
      assert.strictEqual(member?.firstSeenAt.getTime(), 60_000);
      assert.strictEqual(member?.lastSeenAt.getTime(), 120_000);
    }).pipe(Effect.provide(TestLayer)));

  it.effect("stores a repeated write once, since a timed-out write may have gone through", () =>
    Effect.gen(function* () {
      yield* ready;

      const log = yield* ActivityLog;
      const sql = yield* SqlClient.SqlClient;
      const entryId = crypto.randomUUID();

      yield* log.startSession(SESSION, DateTime.makeUnsafe(0));
      yield* log.startSession(SESSION, DateTime.makeUnsafe(0));
      yield* log.record(SESSION, entryId, joined(1));
      yield* log.record(SESSION, entryId, joined(1));

      const [counts] = yield* sql<{ readonly sessions: number; readonly snapshots: number }>`
        SELECT
          (SELECT count(*)::int FROM office.bot_sessions) AS sessions,
          (SELECT count(*)::int FROM office.voice_snapshots) AS snapshots
      `;

      assert.deepStrictEqual(counts, { sessions: 1, snapshots: 1 });
    }).pipe(Effect.provide(TestLayer)));

  it.effect("records a clean stop on the session", () =>
    Effect.gen(function* () {
      yield* ready;

      const log = yield* ActivityLog;
      const sql = yield* SqlClient.SqlClient;

      yield* log.startSession(SESSION, DateTime.makeUnsafe(0));
      yield* log.stopSession(SESSION, DateTime.makeUnsafe(60_000));

      const [session] = yield* sql<{ readonly stoppedAt: Date }>`SELECT stopped_at FROM office.bot_sessions`;

      assert.strictEqual(session?.stoppedAt.getTime(), 60_000);
    }).pipe(Effect.provide(TestLayer)));

  it.effect("sets aside a payload as JSON", () =>
    Effect.gen(function* () {
      yield* ready;

      const log = yield* ActivityLog;
      const sql = yield* SqlClient.SqlClient;

      yield* log.reject(JSON.stringify({ userId: "u1", selfMute: true }), "violates check", DateTime.makeUnsafe(0));

      const [rejected] = yield* sql<{ readonly payload: unknown; readonly error: string }>`
        SELECT payload, error FROM office.rejected_updates
      `;

      assert.deepStrictEqual(rejected?.payload, { userId: "u1", selfMute: true });
      assert.strictEqual(rejected?.error, "violates check");
    }).pipe(Effect.provide(TestLayer)));

  it.effect("reports a row Postgres rejects as a bad row", () =>
    Effect.gen(function* () {
      yield* ready;

      const log = yield* ActivityLog;

      // No session was started, so the snapshot breaks its foreign key.
      const error = yield* log.record(SESSION, crypto.randomUUID(), joined(1)).pipe(Effect.flip);

      assert.instanceOf(error.reason, BadRow);
    }).pipe(Effect.provide(TestLayer)));
});

describe("classify", () => {
  const serverError = (code: string) =>
    new SqlError.SqlError({
      reason: new SqlError.UnknownError({
        message: "PgConnection: Query failed",
        cause: Object.assign(new Error("server said no"), { code }),
      }),
    });

  it("treats data and integrity errors as bad rows", () => {
    assert.instanceOf(classify(serverError("22001")).reason, BadRow);
    assert.instanceOf(classify(serverError("23503")).reason, BadRow);
  });

  it("treats everything else as an outage, even errors it doesn't recognise", () => {
    assert.instanceOf(classify(serverError("08006")).reason, Outage);
    assert.instanceOf(classify(serverError("XX000")).reason, Outage);
    assert.instanceOf(
      classify(new SqlError.SqlError({ reason: new SqlError.ConnectionError({ message: "closed", cause: undefined }) }))
        .reason,
      Outage,
    );
  });
});

describe("voice_activity", () => {
  it.effect("turns snapshots into events, counting what's on as someone arrives", () =>
    Effect.gen(function* () {
      yield* ready;

      const log = yield* ActivityLog;
      const sql = yield* SqlClient.SqlClient;

      yield* log.startSession(SESSION, DateTime.makeUnsafe(0));

      const steps: ReadonlyArray<VoiceObservation> = [
        // Already there at startup, with the camera on.
        observation(0, {
          source: "startup",
          userId: "u2",
          displayName: "Grace",
          oldChannelId: null,
          oldDetails: NO_VOICE_DETAILS,
          newDetails: inVoice({ selfVideo: true }),
        }),
        joined(1, inVoice({ selfMute: true })),
        observation(2, { oldDetails: inVoice({ selfMute: true }), newDetails: inVoice() }),
        // Deafening mutes too.
        observation(3, { newDetails: inVoice({ selfDeaf: true, selfMute: true }) }),
        observation(4, {
          oldDetails: inVoice({ selfDeaf: true, selfMute: true }),
          newDetails: inVoice({ selfDeaf: true, selfMute: true, streaming: true }),
        }),
        observation(5, { oldDetails: inVoice({ serverMute: false }), newDetails: inVoice({ serverMute: true }) }),
        // Moving out leaves, whatever was on.
        observation(6, { newChannelId: "lobby", oldDetails: inVoice({ selfMute: true }), newDetails: inVoice() }),
      ];

      yield* Effect.forEach(steps, (step) => log.record(SESSION, crypto.randomUUID(), step));

      const rows = yield* sql<{ readonly userId: string; readonly event: string; readonly realName: string | null }>`
        SELECT user_id, event, real_name FROM office.voice_activity ORDER BY observed_at, event
      `;

      assert.deepStrictEqual(
        rows.map((row) => `${row.userId} ${row.event}`),
        [
          "u2 AlreadyThere",
          "u2 CameraOn",
          "u1 Joined",
          "u1 Muted",
          "u1 Unmuted",
          "u1 Deafened",
          "u1 Muted",
          "u1 StreamStarted",
          "u1 ServerMuted",
          "u1 Left",
        ],
      );
    }).pipe(Effect.provide(TestLayer)));
});
