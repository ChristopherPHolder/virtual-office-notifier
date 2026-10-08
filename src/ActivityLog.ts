import { Context, DateTime, Effect, Layer, Predicate, Schema } from "effect";
import { SqlClient, type SqlError } from "effect/sql";

import { describeError } from "./Database.ts";
import type { TimedVoiceEffect } from "./VoiceEffect.ts";
import type { VoiceObservation } from "./VoiceObservation.ts";

// The database is unreachable or misbehaving. Worth retrying the same write.
export class Outage extends Schema.TaggedError<Outage>()("Outage", {
  message: Schema.String,
}) {}

// Postgres rejected the data itself. Retrying won't help.
export class BadRow extends Schema.TaggedError<BadRow>()("BadRow", {
  message: Schema.String,
}) {}

export class ActivityLogError extends Schema.TaggedError<ActivityLogError>()("ActivityLogError", {
  reason: Schema.Union([Outage, BadRow]),
}) {}

// Data exceptions (class 22) and integrity violations (class 23) are about the
// row. Anything else, even unrecognised, is treated as an outage: retrying
// forever is better than setting aside a row that was fine.
const sqlStateOf = (error: SqlError.SqlError): string | undefined => {
  const cause = error.reason.cause;

  return Predicate.hasProperty(cause, "code") && Predicate.isString(cause.code) ? cause.code : undefined;
};

export const classify = (error: SqlError.SqlError): ActivityLogError => {
  const state = sqlStateOf(error);
  const message = describeError(error);
  const badRow = state !== undefined && (state.startsWith("22") || state.startsWith("23"));

  return new ActivityLogError({ reason: badRow ? new BadRow({ message }) : new Outage({ message }) });
};

const toDate = (at: DateTime.Utc | null): Date | null => (at === null ? null : DateTime.toDate(at));

// Column names are camelCase here and snake_case in Postgres; the client
// converts them.
export const snapshotRow = (sessionId: string, entryId: string, observation: VoiceObservation) => {
  const { oldDetails: old, newDetails: next } = observation;

  return {
    entryId,
    botSessionId: sessionId,
    source: observation.source,
    observedAt: DateTime.toDate(observation.at),
    guildId: observation.guildId,
    officeChannelId: observation.officeChannelId,
    userId: observation.userId,
    oldChannelId: observation.oldChannelId,
    newChannelId: observation.newChannelId,
    oldSelfMute: old.selfMute,
    newSelfMute: next.selfMute,
    oldSelfDeaf: old.selfDeaf,
    newSelfDeaf: next.selfDeaf,
    oldServerMute: old.serverMute,
    newServerMute: next.serverMute,
    oldServerDeaf: old.serverDeaf,
    newServerDeaf: next.serverDeaf,
    oldSelfVideo: old.selfVideo,
    newSelfVideo: next.selfVideo,
    oldStreaming: old.streaming,
    newStreaming: next.streaming,
    oldSuppress: old.suppress,
    newSuppress: next.suppress,
    oldRequestToSpeakAt: toDate(old.requestToSpeakAt),
    newRequestToSpeakAt: toDate(next.requestToSpeakAt),
    oldSessionId: old.sessionId,
    newSessionId: next.sessionId,
  };
};

export const effectRow = (sessionId: string, entryId: string, effect: TimedVoiceEffect) => ({
  entryId,
  botSessionId: sessionId,
  observedAt: DateTime.toDate(effect.at),
  guildId: effect.guildId,
  channelId: effect.channelId,
  userId: effect.userId,
  soundId: effect.soundId,
  soundName: effect.soundName,
  soundVolume: effect.soundVolume,
  emojiId: effect.emojiId,
  emojiName: effect.emojiName,
  emojiAnimated: effect.emojiAnimated,
  animationType: effect.animationType,
  animationId: effect.animationId,
});

export class ActivityLog extends Context.Service<
  ActivityLog,
  {
    // Each write is safe to repeat, since one that timed out may still have
    // gone through: the session and `entryId` are only stored once.
    startSession(sessionId: string, at: DateTime.Utc): Effect.Effect<void, ActivityLogError>;
    stopSession(sessionId: string, at: DateTime.Utc): Effect.Effect<void, ActivityLogError>;
    record(sessionId: string, entryId: string, observation: VoiceObservation): Effect.Effect<void, ActivityLogError>;
    recordEffect(sessionId: string, entryId: string, effect: TimedVoiceEffect): Effect.Effect<void, ActivityLogError>;
    // Sets aside something that could never be written, as JSON.
    reject(payload: string, error: string, at: DateTime.Utc): Effect.Effect<void, ActivityLogError>;
  }
>()("virtual-office-notifier/ActivityLog") {
  static readonly layer = Layer.effect(
    ActivityLog,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const startSession = Effect.fn("ActivityLog.startSession")(
        (sessionId: string, at: DateTime.Utc) =>
          sql`
            INSERT INTO office.bot_sessions ${sql.insert({ id: sessionId, startedAt: DateTime.toDate(at) })}
            ON CONFLICT (id) DO NOTHING
          `,
        Effect.asVoid,
        Effect.mapError(classify),
      );

      const stopSession = Effect.fn("ActivityLog.stopSession")(
        (sessionId: string, at: DateTime.Utc) =>
          sql`UPDATE office.bot_sessions SET stopped_at = ${DateTime.toDate(at)} WHERE id = ${sessionId}`,
        Effect.asVoid,
        Effect.mapError(classify),
      );

      const upsertMember = (userId: string, displayName: string, seenAt: DateTime.Utc) => sql`
        INSERT INTO office.members AS m ${sql.insert({
          userId,
          displayName,
          firstSeenAt: DateTime.toDate(seenAt),
          lastSeenAt: DateTime.toDate(seenAt),
        })}
        ON CONFLICT (user_id) DO UPDATE SET
          display_name = EXCLUDED.display_name,
          last_seen_at = GREATEST(m.last_seen_at, EXCLUDED.last_seen_at)
      `;

      // The member and the snapshot go in together, so a snapshot never points
      // at a missing member. `real_name` is never touched.
      const record = Effect.fn("ActivityLog.record")(
        (sessionId: string, entryId: string, observation: VoiceObservation) =>
          sql.withTransaction(
            Effect.all([
              upsertMember(observation.userId, observation.displayName, observation.at),
              sql`
                INSERT INTO office.voice_snapshots ${sql.insert(snapshotRow(sessionId, entryId, observation))}
                ON CONFLICT (entry_id) DO NOTHING
              `,
            ]),
          ),
        Effect.asVoid,
        Effect.mapError(classify),
      );

      const recordEffect = Effect.fn("ActivityLog.recordEffect")(
        (sessionId: string, entryId: string, effect: TimedVoiceEffect) =>
          sql.withTransaction(
            Effect.all([
              upsertMember(effect.userId, effect.displayName, effect.at),
              sql`
                INSERT INTO office.voice_effects ${sql.insert(effectRow(sessionId, entryId, effect))}
                ON CONFLICT (entry_id) DO NOTHING
              `,
            ]),
          ),
        Effect.asVoid,
        Effect.mapError(classify),
      );

      const reject = Effect.fn("ActivityLog.reject")(
        (payload: string, error: string, at: DateTime.Utc) =>
          sql`INSERT INTO office.rejected_updates ${sql.insert({ rejectedAt: DateTime.toDate(at), payload, error })}`,
        Effect.asVoid,
        Effect.mapError(classify),
      );

      return ActivityLog.of({ startSession, stopSession, record, recordEffect, reject });
    }),
  );
}
