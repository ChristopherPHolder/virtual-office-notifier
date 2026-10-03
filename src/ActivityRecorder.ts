import {
  Cause,
  Context,
  Data,
  DateTime,
  Duration,
  Effect,
  ErrorReporter,
  Fiber,
  Layer,
  type LogLevel,
  Option,
  Queue,
  Ref,
  Schedule,
  Schema,
} from "effect";

import { ActivityLog, ActivityLogError, Outage } from "./ActivityLog.ts";
import { DatabaseConfig } from "./Config.ts";
import { Database, DatabaseUnavailable, describeError, reconnectSchedule } from "./Database.ts";
import type { VoiceObservation } from "./VoiceObservation.ts";

// Many days of office traffic, and a few MB at most.
export const BUFFER_SIZE = 50_000;

// A write taking this long is treated like the database being down.
const WRITE_TIMEOUT = Duration.seconds(10);

// How long a shutdown waits for the buffer to be written.
export const FLUSH_TIMEOUT = Duration.seconds(10);

// What's waiting to be written, in the order it happened.
export type Entry = Data.TaggedEnum<{
  SessionStarted: { readonly sessionId: string; readonly at: DateTime.Utc };
  Observed: { readonly sessionId: string; readonly entryId: string; readonly observation: VoiceObservation };
  SessionStopped: { readonly sessionId: string; readonly at: DateTime.Utc };
}>;

export const Entry = Data.taggedEnum<Entry>();

// The errors reported to Sentry carry what went wrong, never the entry, since
// that holds people's names and IDs.

// An update that only made it into the journal.
export class UpdateNotStored extends Schema.TaggedError<UpdateNotStored>()("UpdateNotStored", {
  message: Schema.String,
}) {
  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Error";
  }
}

// An update Postgres rejected, kept in rejected_updates.
export class UpdateSetAside extends Schema.TaggedError<UpdateSetAside>()("UpdateSetAside", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `The database rejected an update: ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason };
  }
}

export class RecordingDisabled extends Schema.TaggedError<RecordingDisabled>()("RecordingDisabled", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `Couldn't create the database client, so nothing is recorded: ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Error";
  }
}

const report = (error: UpdateNotStored | UpdateSetAside | RecordingDisabled | DatabaseUnavailable) =>
  ErrorReporter.report(Cause.fail(error));

// Anything that can't be stored is logged in full instead, so it's never lost
// without a trace.
const logInstead = (message: string, entry: Entry) =>
  Effect.logError(message).pipe(
    Effect.annotateLogs({ entry: JSON.stringify(entry) }),
    Effect.andThen(report(new UpdateNotStored({ message }))),
  );

const outageRetry = reconnectSchedule.pipe(
  Schedule.setInputType<ActivityLogError>(),
  Schedule.while(({ input }) => input.reason instanceof Outage),
  Schedule.tap(({ input, attempt, duration }) =>
    Effect.logWarning("Couldn't record to the database, retrying").pipe(
      Effect.annotateLogs({ reason: input.reason.message, attempt, delayMs: Duration.toMillis(duration) }),
      Effect.andThen(report(new DatabaseUnavailable({ reason: input.reason.message }))),
    ),
  ),
);

export class ActivityRecorder extends Context.Service<
  ActivityRecorder,
  {
    // Never fails or waits on the database: the observation is buffered and
    // written in the background.
    record(observation: VoiceObservation): Effect.Effect<void>;
  }
>()("virtual-office-notifier/ActivityRecorder") {
  // One writer drains the buffer in order. An outage keeps the entry at the
  // front and retries on the reconnect schedule. A row Postgres rejects goes
  // to rejected_updates instead, so it can't block everything behind it.
  static readonly layerNoDeps = Layer.effect(
    ActivityRecorder,
    Effect.gen(function* () {
      const database = yield* Database;
      const log = yield* ActivityLog;

      const sessionId = crypto.randomUUID();
      // Dropping keeps the oldest entries when full, and refuses new ones.
      const buffer = yield* Queue.dropping<Entry, Cause.Done>(BUFFER_SIZE);
      const inFlight = yield* Ref.make(Option.none<Entry>());

      const enqueue = (entry: Entry) =>
        Queue.offer(buffer, entry).pipe(
          Effect.flatMap((accepted) =>
            accepted ? Effect.void : logInstead("Recording buffer is full or closed, logging this instead", entry),
          ),
        );

      const persist = Entry.$match({
        SessionStarted: ({ sessionId, at }) => log.startSession(sessionId, at),
        Observed: ({ sessionId, entryId, observation }) => log.record(sessionId, entryId, observation),
        SessionStopped: ({ sessionId, at }) => log.stopSession(sessionId, at),
      });

      const setAside = (entry: Entry, error: ActivityLogError) =>
        DateTime.now.pipe(
          Effect.flatMap((at) => log.reject(JSON.stringify(entry), error.reason.message, at)),
          Effect.timeout(WRITE_TIMEOUT),
          Effect.andThen(
            Effect.logWarning("The database rejected an update, set it aside in rejected_updates").pipe(
              Effect.annotateLogs({ reason: error.reason.message }),
              Effect.andThen(report(new UpdateSetAside({ reason: error.reason.message }))),
            ),
          ),
          Effect.catch((rejectError) =>
            logInstead("Couldn't record or set aside an update, logging it instead", entry).pipe(
              Effect.annotateLogs({ reason: error.reason.message, setAsideError: describeError(rejectError) }),
            ),
          ),
        );

      const write = (entry: Entry) =>
        persist(entry).pipe(
          Effect.timeoutOrElse({
            duration: WRITE_TIMEOUT,
            orElse: () =>
              Effect.fail(new ActivityLogError({ reason: new Outage({ message: "Timed out after 10 seconds" }) })),
          }),
          Effect.retry(outageRetry),
          Effect.catchTag("ActivityLogError", (error) => setAside(entry, error)),
        );

      // Takes one entry at a time, so everything not yet written is either in
      // the buffer or in `inFlight`, and a shutdown that interrupts a retry can
      // still log it. Taking and marking it in flight can't be split by an
      // interruption.
      const writeNext = Effect.uninterruptibleMask((restore) =>
        restore(Queue.take(buffer)).pipe(Effect.tap((entry) => Ref.set(inFlight, Option.some(entry)))),
      ).pipe(
        Effect.flatMap(write),
        Effect.andThen(Ref.set(inFlight, Option.none())),
      );

      yield* enqueue(Entry.SessionStarted({ sessionId, at: yield* DateTime.now }));

      // Waits for the database to be connected and migrated, buffering until
      // then. Ends once the buffer is closed and empty.
      const writer = yield* database.ready.pipe(
        Effect.andThen(Effect.forever(writeNext)),
        Effect.catchIf(Cause.isDone, () => Effect.void),
        Effect.forkScoped,
      );

      // Added after the writer is forked, so it runs while the writer is still
      // alive. New observations are refused and logged from here on.
      yield* Effect.addFinalizer(() =>
        Effect.gen(function* () {
          yield* enqueue(Entry.SessionStopped({ sessionId, at: yield* DateTime.now }));
          yield* Queue.end(buffer);

          const flushed = yield* Fiber.await(writer).pipe(Effect.timeoutOption(FLUSH_TIMEOUT));

          if (Option.isSome(flushed)) return;

          yield* Fiber.interrupt(writer);

          const unwritten = [...Option.toArray(yield* Ref.get(inFlight)), ...(yield* Queue.clear(buffer))];

          yield* Effect.forEach(unwritten, (entry) =>
            logInstead("Couldn't record before shutting down, logging this instead", entry),
          );
        }),
      );

      return ActivityRecorder.of({
        record: (observation) => enqueue(Entry.Observed({ sessionId, entryId: crypto.randomUUID(), observation })),
      });
    }),
  );

  static readonly layerDisabled = Layer.succeed(ActivityRecorder, ActivityRecorder.of({ record: () => Effect.void }));

  // What the bot runs with. It never fails, so the database can't stop the
  // announcements: without DATABASE_URL nothing is recorded.
  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { url } = yield* DatabaseConfig;

      return Option.match(url, {
        onNone: () =>
          ActivityRecorder.layerDisabled.pipe(
            Layer.tap(() => Effect.logInfo("DATABASE_URL isn't set, so nothing is recorded")),
          ),
        onSome: (url) =>
          ActivityRecorder.layerNoDeps.pipe(
            Layer.provide(Layer.provideMerge(ActivityLog.layer, Database.layer(url))),
            Layer.catch((error) =>
              ActivityRecorder.layerDisabled.pipe(
                Layer.tap(() =>
                  Effect.logError("Couldn't create the database client, so nothing is recorded").pipe(
                    Effect.annotateLogs({ reason: describeError(error) }),
                    Effect.andThen(report(new RecordingDisabled({ reason: describeError(error) }))),
                  ),
                ),
              ),
            ),
          ),
      });
    }),
  );
}
