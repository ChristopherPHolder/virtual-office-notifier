import { Context, DateTime, Duration, Effect, Layer, Schema } from "effect";
import { SqlClient } from "effect/sql";

import { Database, describeError } from "./Database.ts";
import type { ActivityEntry, BanterPeriod } from "./OfficeEvent.ts";

export const MAX_ACTIVITY_ENTRIES = 400;

const READ_TIMEOUT = Duration.seconds(10);

export class HistoryUnavailable extends Schema.TaggedError<HistoryUnavailable>()("HistoryUnavailable", {
  reason: Schema.String,
}) {}

const decodeActivityRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      observedAt: Schema.DateTimeUtcFromDate,
      who: Schema.String,
      event: Schema.String,
      total: Schema.Int,
    }),
  ),
);

export interface RecentActivity {
  readonly entriesOldestFirst: ReadonlyArray<ActivityEntry>;
  readonly olderEntriesLeftOut: number;
}

const notRecording = () => Effect.fail(new HistoryUnavailable({ reason: "Nothing is recorded" }));

export class OfficeHistory extends Context.Service<
  OfficeHistory,
  {
    latestActivityBetween(from: DateTime.Utc, until: DateTime.Utc): Effect.Effect<RecentActivity, HistoryUnavailable>;
    readonly presentSinceBotStarted: Effect.Effect<ReadonlyArray<string>, HistoryUnavailable>;
    banterPostsSince(from: DateTime.Utc): Effect.Effect<number, HistoryUnavailable>;
    recordBanterPost(at: DateTime.Utc, period: BanterPeriod): Effect.Effect<void, HistoryUnavailable>;
  }
>()("virtual-office-notifier/OfficeHistory") {
  static readonly layer = Layer.effect(
    OfficeHistory,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const database = yield* Database;

      const onceReady = <A, E extends Error>(query: Effect.Effect<A, E>) =>
        database.ready.pipe(
          Effect.andThen(query),
          Effect.mapError((error) => new HistoryUnavailable({ reason: describeError(error) })),
          Effect.timeoutOrElse({
            duration: READ_TIMEOUT,
            orElse: () => Effect.fail(new HistoryUnavailable({ reason: "Timed out after 10 seconds" })),
          }),
        );

      const latestActivityBetween = Effect.fn("OfficeHistory.latestActivityBetween")(function* (
        from: DateTime.Utc,
        until: DateTime.Utc,
      ) {
        const newestFirst = yield* onceReady(
          sql`
            SELECT
              observed_at,
              coalesce(real_name, display_name) AS who,
              concat_ws(' ', event, detail) AS event,
              count(*) OVER ()::int AS total
            FROM office.office_activity
            WHERE observed_at >= ${DateTime.toDate(from)} AND observed_at < ${DateTime.toDate(until)}
            ORDER BY observed_at DESC, snapshot_id DESC NULLS LAST, effect_id DESC NULLS LAST
            LIMIT ${MAX_ACTIVITY_ENTRIES}
          `.pipe(Effect.flatMap(decodeActivityRows)),
        );

        return {
          entriesOldestFirst: newestFirst.map(({ observedAt, who, event }) => ({ at: observedAt, who, event })).reverse(),
          olderEntriesLeftOut: (newestFirst[0]?.total ?? 0) - newestFirst.length,
        };
      });

      const presentSinceBotStarted = onceReady(
        sql<{ readonly who: string }>`
          SELECT who FROM (
            SELECT DISTINCT ON (user_id) coalesce(real_name, display_name) AS who, event
            FROM office.voice_activity
            WHERE bot_session_id = (SELECT id FROM office.bot_sessions ORDER BY started_at DESC LIMIT 1)
              AND event IN ('AlreadyThere', 'Joined', 'Left')
            ORDER BY user_id, observed_at DESC, snapshot_id DESC
          ) AS latest_arrival_or_departure
          WHERE event <> 'Left'
          ORDER BY who
        `,
      ).pipe(
        Effect.map((rows) => rows.map((row) => row.who)),
        Effect.withSpan("OfficeHistory.presentSinceBotStarted"),
      );

      const banterPostsSince = Effect.fn("OfficeHistory.banterPostsSince")(function* (from: DateTime.Utc) {
        const [row] = yield* onceReady(
          sql<{ readonly posts: number }>`
            SELECT count(*)::int AS posts FROM office.banter_posts WHERE posted_at >= ${DateTime.toDate(from)}
          `,
        );

        return row?.posts ?? 0;
      });

      const recordBanterPost = Effect.fn("OfficeHistory.recordBanterPost")(
        (at: DateTime.Utc, period: BanterPeriod) =>
          onceReady(sql`INSERT INTO office.banter_posts ${sql.insert({ postedAt: DateTime.toDate(at), period })}`),
        Effect.asVoid,
      );

      return OfficeHistory.of({ latestActivityBetween, presentSinceBotStarted, banterPostsSince, recordBanterPost });
    }),
  );

  static readonly layerDisabled = Layer.succeed(
    OfficeHistory,
    OfficeHistory.of({
      latestActivityBetween: notRecording,
      presentSinceBotStarted: notRecording(),
      banterPostsSince: notRecording,
      recordBanterPost: notRecording,
    }),
  );
}
