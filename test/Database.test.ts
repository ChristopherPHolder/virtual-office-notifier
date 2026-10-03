import { PgliteClient } from "@effect/sql-pglite";
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Queue, Ref } from "effect";
import { Migrator, SqlClient, SqlError } from "effect/sql";
import { TestClock } from "effect/testing";

import { Database, DatabaseLive, describeError, reconnectDelay } from "../src/Database.ts";
import { withEnv } from "./fakes.ts";

const createExample = Migrator.fromRecord({
  "0001_create_example": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`CREATE TABLE office.example (id integer PRIMARY KEY)`;
  }),
});

const awaitReady = Effect.gen(function* () {
  const database = yield* Database;

  yield* database.ready;
});

const migrationNames = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly name: string }>`SELECT name FROM office.migrations ORDER BY migration_id`;

  return rows.map((row) => row.name);
});

describe("reconnectDelay", () => {
  it("retries in bursts of 5 with an hour's wait between bursts", () => {
    const delays = Array.from({ length: 12 }, (_, index) => Duration.toSeconds(reconnectDelay(index + 1)));

    assert.deepStrictEqual(delays, [1, 2, 4, 8, 16, 3600, 1, 2, 4, 8, 16, 3600]);
  });
});

describe("describeError", () => {
  it("adds what went wrong to the driver's generic message", () => {
    const error = new SqlError.SqlError({
      reason: new SqlError.ConnectionError({
        message: "PgConnection: Failed to connect",
        cause: new Error("password authentication failed for user \"postgres.ref\""),
      }),
    });

    assert.strictEqual(
      describeError(error),
      "PgConnection: Failed to connect: password authentication failed for user \"postgres.ref\"",
    );
  });
});

describe("Database", () => {
  it.effect("creates the office schema and runs the migrations", () =>
    Effect.gen(function* () {
      yield* awaitReady.pipe(Effect.provide(Database.layerNoDeps(createExample)));

      const sql = yield* SqlClient.SqlClient;

      yield* sql`INSERT INTO office.example (id) VALUES (1)`;

      assert.deepStrictEqual(yield* migrationNames, ["create_example"]);
    }).pipe(Effect.provide(PgliteClient.layer())));

  it.effect("runs each migration once across restarts", () =>
    Effect.gen(function* () {
      yield* awaitReady.pipe(Effect.provide(Database.layerNoDeps(createExample)));
      yield* awaitReady.pipe(Effect.provide(Database.layerNoDeps(createExample)));

      assert.deepStrictEqual(yield* migrationNames, ["create_example"]);
    }).pipe(Effect.provide(PgliteClient.layer())));

  it.effect("keeps retrying in the background until it can set up the database", () =>
    Effect.gen(function* () {
      const attempts = yield* Queue.unbounded<number>();
      const count = yield* Ref.make(0);

      // Fails the first 6 attempts: a whole burst, then the first attempt
      // after the hour's wait.
      const flakyLoader = Ref.updateAndGet(count, (n) => n + 1).pipe(
        Effect.tap((attempt) => Queue.offer(attempts, attempt)),
        Effect.flatMap((attempt) =>
          attempt <= 6
            ? Effect.fail(new Migrator.MigrationError({ kind: "Failed", message: "unreachable" }))
            : createExample,
        ),
      );

      const ready = yield* awaitReady.pipe(Effect.provide(Database.layerNoDeps(flakyLoader)), Effect.forkChild);

      assert.strictEqual(yield* Queue.take(attempts), 1);

      for (const { wait, attempt } of [
        { wait: 1, attempt: 2 },
        { wait: 2, attempt: 3 },
        { wait: 4, attempt: 4 },
        { wait: 8, attempt: 5 },
        { wait: 16, attempt: 6 },
        { wait: 3600, attempt: 7 },
      ]) {
        assert.isUndefined(ready.pollUnsafe());

        yield* TestClock.adjust(Duration.seconds(wait));

        assert.strictEqual(yield* Queue.take(attempts), attempt);
      }

      yield* Fiber.join(ready);

      assert.deepStrictEqual(yield* migrationNames, ["create_example"]);
    }).pipe(Effect.provide(PgliteClient.layer())));
});

describe("DatabaseLive", () => {
  it.effect.each([
    { case: "without DATABASE_URL", env: {} },
    { case: "with a blank DATABASE_URL", env: { DATABASE_URL: " " } },
    { case: "with a DATABASE_URL it can't parse", env: { DATABASE_URL: "not a url" } },
    { case: "while the database is unreachable", env: { DATABASE_URL: "postgres://user:secret@127.0.0.1:1/postgres" } },
  ])("never fails startup $case", ({ env }) =>
    Layer.build(DatabaseLive).pipe(Effect.scoped, withEnv(env), Effect.asVoid));
});
