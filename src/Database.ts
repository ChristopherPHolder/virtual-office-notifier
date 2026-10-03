import { PgClient } from "@effect/sql-pg";
import { Context, Deferred, Duration, Effect, Layer, Option, type Redacted, Schedule, String } from "effect";
import { Migrator, SqlClient, type SqlError } from "effect/sql";

import { DatabaseConfig } from "./Config.ts";
import { migrations } from "./migrations.ts";
import { SUPABASE_ROOT_CA } from "./SupabaseCa.ts";

// Everything the bot stores lives here, out of the `public` schema that
// Supabase serves through its REST API.
export const SCHEMA = "office";

// Bursts of 5 retries 1, 2, 4, 8 and 16 seconds apart, with an hour's wait
// before the next burst, forever. `attempt` counts retries from 1.
export const reconnectDelay = (attempt: number): Duration.Duration => {
  const step = (attempt - 1) % 6;

  return step === 5 ? Duration.hours(1) : Duration.seconds(2 ** step);
};

export const reconnectSchedule = Schedule.forever.pipe(
  Schedule.modifyDelay(({ attempt }) => Effect.succeed(reconnectDelay(attempt))),
);

// The driver's own message is generic ("Failed to connect"), and what went
// wrong, like a bad password, is in the causes. Only the messages are kept:
// the error objects could carry connection details.
export const describeError = (error: Error): string => {
  const messages: Array<string> = [];

  for (let cause: unknown = error; cause instanceof Error; cause = cause.cause) {
    if (messages.at(-1) !== cause.message) messages.push(cause.message);
  }

  return messages.join(": ");
};

const retryLogged = reconnectSchedule.pipe(
  Schedule.setInputType<SqlError.SqlError | Migrator.MigrationError>(),
  Schedule.tap(({ input, attempt, duration }) =>
    Effect.logWarning("Couldn't set up the database, retrying").pipe(
      Effect.annotateLogs({ reason: describeError(input), attempt, delayMs: Duration.toMillis(duration) }),
    ),
  ),
);

const runMigrations = Migrator.make({});

export class Database extends Context.Service<
  Database,
  {
    // Completes once the database is connected and migrated. Never fails:
    // until then, connecting is retried in the background.
    readonly ready: Effect.Effect<void>;
  }
>()("virtual-office-notifier/Database") {
  // Connecting happens in the background, so building this never waits on
  // the database, and a database that's down can't hold up the bot.
  static readonly layerNoDeps = (loader: Migrator.Loader = migrations) =>
    Layer.effect(
      Database,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const ready = yield* Deferred.make<void>();

        const connect = Effect.gen(function* () {
          yield* sql`CREATE SCHEMA IF NOT EXISTS ${sql(SCHEMA)}`;

          return yield* runMigrations({ loader, table: `${SCHEMA}.migrations` });
        });

        yield* connect.pipe(
          Effect.retry(retryLogged),
          Effect.tap((applied) =>
            Effect.logInfo("Connected to the database").pipe(
              Effect.annotateLogs({ migrationsApplied: applied.length }),
            ),
          ),
          Effect.andThen(Deferred.succeed(ready, undefined)),
          Effect.forkScoped,
        );

        return Database.of({ ready: Deferred.await(ready) });
      }),
    );

  // The URL is only parsed when a connection opens, so a bad one shows up as
  // retries in the logs rather than failing here.
  static readonly layer = (url: Redacted.Redacted<string>) =>
    Database.layerNoDeps().pipe(
      Layer.provideMerge(
        PgClient.layer({
          url,
          ssl: { ca: SUPABASE_ROOT_CA },
          maxConnections: 2,
          applicationName: "virtual-office-notifier",
          transformQueryNames: String.camelToSnake,
          transformResultNames: String.snakeToCamel,
        }),
      ),
    );
}

// What the bot runs with. It never fails, so the database can't stop the
// announcements: without DATABASE_URL nothing connects. Nothing reads from the
// database yet.
export const DatabaseLive = Layer.unwrap(
  Effect.gen(function* () {
    const { url } = yield* DatabaseConfig;

    return Option.match(url, {
      onNone: () => Layer.effectDiscard(Effect.logInfo("DATABASE_URL isn't set, so nothing is recorded")),
      onSome: (url) =>
        Layer.effectDiscard(Effect.void).pipe(
          Layer.provide(Database.layer(url)),
          Layer.catch((error) =>
            Layer.effectDiscard(
              Effect.logError("Couldn't create the database client, so nothing is recorded").pipe(
                Effect.annotateLogs({ reason: describeError(error) }),
              ),
            ),
          ),
        ),
    });
  }),
);
