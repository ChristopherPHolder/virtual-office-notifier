import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Context, DateTime, Deferred, Effect, Exit, Fiber, Layer, Logger, Queue, Ref, References, Scope } from "effect";
import { SqlClient } from "effect/sql";
import { TestClock } from "effect/testing";

import { ActivityLog, ActivityLogError, BadRow, Outage } from "../src/ActivityLog.ts";
import { ActivityRecorder, BUFFER_SIZE } from "../src/ActivityRecorder.ts";
import { columnNaming, Database } from "../src/Database.ts";
import { NO_VOICE_DETAILS } from "../src/OfficeEvent.ts";
import type { VoiceObservation } from "../src/VoiceObservation.ts";
import { captureReports, withEnv } from "./fakes.ts";

const observation = (userId: string): VoiceObservation => ({
  source: "update",
  officeChannelId: "office",
  userId,
  displayName: userId,
  avatarUrl: null,
  guildId: "g1",
  isBot: false,
  oldChannelId: null,
  newChannelId: "office",
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
  at: DateTime.makeUnsafe(0),
});

const outage = new ActivityLogError({ reason: new Outage({ message: "connection closed" }) });

const badRow = new ActivityLogError({ reason: new BadRow({ message: "violates check constraint" }) });

const outages = (count: number) => Array.from({ length: count }, () => outage);

// A fake ActivityLog that reports every call, in order, and fails the calls
// it's told to, one failure per call.
const makeFakeLog = Effect.fnUntraced(function* (
  failures: Readonly<Partial<Record<string, ReadonlyArray<ActivityLogError>>>> = {},
) {
  const calls = yield* Queue.unbounded<string>();
  const remaining = yield* Ref.make(failures);

  const call = (name: string) =>
    Queue.offer(calls, name).pipe(
      Effect.andThen(
        Ref.modify(remaining, (all) => {
          const scripted = all[name];

          if (scripted === undefined) return [undefined, all] as const;

          const [next, ...rest] = scripted;

          return [next, { ...all, [name]: rest }] as const;
        }),
      ),
      Effect.flatMap((failure) => (failure === undefined ? Effect.void : Effect.fail(failure))),
    );

  const log = ActivityLog.of({
    startSession: () => call("start"),
    stopSession: () => call("stop"),
    record: (_session, _entry, { userId }) => call(`record ${userId}`),
    reject: (payload) => call(payload.includes(`"userId":"u1"`) ? "reject u1" : "reject"),
  });

  return { log, takeCall: Queue.take(calls), allCalls: Queue.clear(calls) };
});

interface LogEntry {
  readonly message: string;
  readonly entry: string;
}

const captureLogs = () => {
  const messages: Array<LogEntry> = [];

  const logger = Logger.make<unknown, void>((options) => {
    const annotations = options.fiber.getRef(References.CurrentLogAnnotations);

    messages.push({
      message: String(Array.isArray(options.message) ? options.message[0] : options.message),
      entry: String(annotations["entry"] ?? ""),
    });
  });

  return { messages, layer: Logger.layer([logger]) };
};

const messagesStartingWith = (messages: ReadonlyArray<LogEntry>, prefix: string) =>
  messages.filter((log) => log.message.startsWith(prefix));

// Builds the recorder in its own scope, so tests can shut it down.
const startRecorder = Effect.fnUntraced(function* (
  log: ActivityLog["Service"],
  ready: Effect.Effect<void> = Effect.void,
) {
  const scope = yield* Scope.make();

  const context = yield* Layer.buildWithScope(
    ActivityRecorder.layerNoDeps.pipe(
      Layer.provide(Layer.succeed(ActivityLog, log)),
      Layer.provide(Layer.succeed(Database, Database.of({ ready }))),
    ),
    scope,
  );

  return { recorder: Context.get(context, ActivityRecorder), stop: Scope.close(scope, Exit.void) };
});

describe("ActivityRecorder", () => {
  it.effect("writes the session start, each observation and the session stop, in order", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeLog();
      const { recorder, stop } = yield* startRecorder(fake.log);

      yield* recorder.record(observation("u1"));
      yield* recorder.record(observation("u2"));
      yield* stop;

      assert.deepStrictEqual(yield* fake.allCalls, ["start", "record u1", "record u2", "stop"]);
    }));

  it.effect("buffers until the database is ready", () =>
    Effect.gen(function* () {
      const fake = yield* makeFakeLog();
      const ready = yield* Deferred.make<void>();
      const { recorder, stop } = yield* startRecorder(fake.log, Deferred.await(ready));

      yield* recorder.record(observation("u1"));
      yield* Effect.yieldNow;

      assert.deepStrictEqual(yield* fake.allCalls, []);

      yield* Deferred.succeed(ready, undefined);
      yield* stop;

      assert.deepStrictEqual(yield* fake.allCalls, ["start", "record u1", "stop"]);
    }));

  it.effect("retries an outage on the reconnect schedule without losing its place, reporting each retry", () => {
    const { reports, layer } = captureReports();

    return Effect.gen(function* () {
      const fake = yield* makeFakeLog({ "record u1": outages(2) });
      const { recorder, stop } = yield* startRecorder(fake.log);

      yield* recorder.record(observation("u1"));
      yield* recorder.record(observation("u2"));

      assert.strictEqual(yield* fake.takeCall, "start");
      assert.strictEqual(yield* fake.takeCall, "record u1");

      yield* TestClock.adjust("1 second");
      assert.strictEqual(yield* fake.takeCall, "record u1");

      yield* TestClock.adjust("2 seconds");
      assert.strictEqual(yield* fake.takeCall, "record u1");
      assert.strictEqual(yield* fake.takeCall, "record u2");

      yield* stop;

      const retry = {
        name: "DatabaseUnavailable",
        message: "Couldn't reach the database: connection closed",
        severity: "Warn",
      };

      assert.deepStrictEqual(reports, [retry, retry]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("sets aside a row the database rejects and carries on, reporting a warning", () => {
    const { reports, layer } = captureReports();

    return Effect.gen(function* () {
      const fake = yield* makeFakeLog({ "record u1": [badRow] });
      const { recorder, stop } = yield* startRecorder(fake.log);

      yield* recorder.record(observation("u1"));
      yield* recorder.record(observation("u2"));
      yield* stop;

      assert.deepStrictEqual(yield* fake.allCalls, ["start", "record u1", "reject u1", "record u2", "stop"]);
      assert.deepStrictEqual(reports, [
        {
          name: "UpdateSetAside",
          message: "The database rejected an update: violates check constraint",
          severity: "Warn",
        },
      ]);
    }).pipe(Effect.provide(layer));
  });

  it.effect("logs an update in full when it can't be recorded or set aside, reporting an error without it", () =>
    Effect.gen(function* () {
      const logs = captureLogs();
      const { reports, layer } = captureReports();
      const fake = yield* makeFakeLog({ "record u1": [badRow], "reject u1": [outage] });

      yield* Effect.gen(function* () {
        const { recorder, stop } = yield* startRecorder(fake.log);

        yield* recorder.record(observation("u1"));
        yield* stop;
      }).pipe(Effect.provide(Layer.merge(logs.layer, layer)));

      const lost = messagesStartingWith(logs.messages, "Couldn't record or set aside");

      assert.strictEqual(lost.length, 1);
      assert.include(lost[0]?.entry, `"userId":"u1"`);
      assert.deepStrictEqual(reports, [
        {
          name: "UpdateNotStored",
          message: "Couldn't record or set aside an update, logging it instead",
          severity: "Error",
        },
      ]);
      assert.notInclude(JSON.stringify(reports), "u1");
    }));

  it.effect("refuses observations once the buffer is full, logging each one", () =>
    Effect.gen(function* () {
      const logs = captureLogs();
      const fake = yield* makeFakeLog();
      const ready = yield* Deferred.make<void>();

      yield* Effect.gen(function* () {
        const { recorder, stop } = yield* startRecorder(fake.log, Deferred.await(ready));

        // The session start already takes one place.
        for (let index = 0; index < BUFFER_SIZE; index++) {
          yield* recorder.record(observation(`u${index}`));
        }

        yield* Deferred.succeed(ready, undefined);
        yield* stop;
      }).pipe(Effect.provide(logs.layer));

      const refused = messagesStartingWith(logs.messages, "Recording buffer is full");

      assert.strictEqual(refused.length, 1);
      assert.include(refused[0]?.entry, `"userId":"u${BUFFER_SIZE - 1}"`);
    }));

  it.effect("logs everything still unwritten when shutdown can't finish in time", () =>
    Effect.gen(function* () {
      const logs = captureLogs();
      const fake = yield* makeFakeLog({ "record u1": outages(20) });

      const stopping = yield* Effect.gen(function* () {
        const { recorder, stop } = yield* startRecorder(fake.log);

        yield* recorder.record(observation("u1"));
        yield* recorder.record(observation("u2"));

        assert.strictEqual(yield* fake.takeCall, "start");
        assert.strictEqual(yield* fake.takeCall, "record u1");

        return yield* Effect.forkChild(stop);
      }).pipe(Effect.provide(logs.layer));

      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(stopping);

      const unwritten = messagesStartingWith(logs.messages, "Couldn't record before shutting down").map(
        (log) => JSON.parse(log.entry)._tag,
      );

      // The one being retried, then what was queued behind it.
      assert.deepStrictEqual(unwritten, ["Observed", "Observed", "SessionStopped"]);
    }));
});

describe("ActivityRecorder.layer", () => {
  it.effect.each([
    { case: "without DATABASE_URL", env: {} },
    { case: "with a blank DATABASE_URL", env: { DATABASE_URL: " " } },
    { case: "with a DATABASE_URL it can't parse", env: { DATABASE_URL: "not a url" } },
    { case: "while the database is unreachable", env: { DATABASE_URL: "postgres://user:secret@127.0.0.1:1/postgres" } },
  ])("never fails startup or shutdown $case", ({ env }) =>
    Effect.gen(function* () {
      const building = yield* Layer.build(ActivityRecorder.layer).pipe(Effect.scoped, withEnv(env), Effect.forkChild);

      // Shutting down waits up to 10 seconds for a database that never came up.
      // The real connection attempt needs real time to fail, so the test clock
      // moves on in steps until it's done.
      while (building.pollUnsafe() === undefined) {
        yield* TestClock.adjust("10 seconds");
        yield* TestClock.withLive(Effect.sleep("10 millis"));
      }

      yield* Fiber.join(building);
    }));

  it.effect("records into the database, from session start to clean stop", () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();

      const context = yield* Layer.buildWithScope(
        ActivityRecorder.layerNoDeps.pipe(Layer.provide(Layer.provideMerge(ActivityLog.layer, Database.layerNoDeps()))),
        scope,
      );

      const recorder = Context.get(context, ActivityRecorder);

      yield* recorder.record(observation("u1"));
      yield* recorder.record(observation("u2"));
      yield* Scope.close(scope, Exit.void);

      const sql = yield* SqlClient.SqlClient;

      const [counts] = yield* sql<{ readonly snapshots: number; readonly stopped: number }>`
        SELECT
          (SELECT count(*)::int FROM office.voice_snapshots) AS snapshots,
          (SELECT count(*)::int FROM office.bot_sessions WHERE stopped_at IS NOT NULL) AS stopped
      `;

      assert.deepStrictEqual(counts, { snapshots: 2, stopped: 1 });
    }).pipe(Effect.provide(PgliteClient.layer(columnNaming))));
});
