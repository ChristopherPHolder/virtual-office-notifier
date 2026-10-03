import { PgClient } from "@effect/sql-pg";
import {
  Cause,
  Context,
  Deferred,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  type LogLevel,
  type Redacted,
  Schedule,
  Schema,
  String,
} from "effect";
import { Migrator, SqlClient, type SqlError } from "effect/sql";

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

// Reported to Sentry on every retry, connecting or writing. Like the logs, it
// only carries the messages, never the error objects.
export class DatabaseUnavailable extends Schema.TaggedError<DatabaseUnavailable>()("DatabaseUnavailable", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Couldn't reach the database: ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason };
  }
}

const retryLogged = reconnectSchedule.pipe(
  Schedule.setInputType<SqlError.SqlError | Migrator.MigrationError>(),
  Schedule.tap(({ input, attempt, duration }) =>
    Effect.logWarning("Couldn't set up the database, retrying").pipe(
      Effect.annotateLogs({ reason: describeError(input), attempt, delayMs: Duration.toMillis(duration) }),
      Effect.andThen(ErrorReporter.report(Cause.fail(new DatabaseUnavailable({ reason: describeError(input) })))),
    ),
  ),
);

// camelCase in TypeScript, snake_case in Postgres.
export const columnNaming = {
  transformQueryNames: String.camelToSnake,
  transformResultNames: String.snakeToCamel,
};

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
          ...columnNaming,
        }),
      ),
    );
}
