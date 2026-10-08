import { Effect } from "effect";
import { Migrator, SqlClient } from "effect/sql";

// Each flag turns into a pair of events in the voice_activity view.
const FLAG_EVENTS = [
  ["self_mute", "Muted", "Unmuted"],
  ["self_deaf", "Deafened", "Undeafened"],
  ["server_mute", "ServerMuted", "ServerUnmuted"],
  ["server_deaf", "ServerDeafened", "ServerUndeafened"],
  ["self_video", "CameraOn", "CameraOff"],
  ["streaming", "StreamStarted", "StreamStopped"],
] as const;

// A flag that's on as someone arrives counts as switched on, so the events
// alone say what state anyone was in. Leaving only says `Left`.
const flagEvents = FLAG_EVENTS.flatMap(([column, on, off]) => [
  `(CASE WHEN place.is_in AND s.new_${column} IS TRUE AND NOT (place.was_in AND s.old_${column} IS TRUE) THEN '${on}' END)`,
  `(CASE WHEN place.was_in AND place.is_in AND s.old_${column} IS TRUE AND s.new_${column} IS FALSE THEN '${off}' END)`,
]);

const voiceActivityView = `
  CREATE VIEW office.voice_activity AS
  SELECT
    s.id AS snapshot_id,
    s.observed_at,
    s.bot_session_id,
    s.user_id,
    m.display_name,
    m.real_name,
    e.event,
    s.old_channel_id,
    s.new_channel_id
  FROM office.voice_snapshots s
  JOIN office.members m USING (user_id)
  CROSS JOIN LATERAL (
    SELECT
      s.old_channel_id IS NOT DISTINCT FROM s.office_channel_id AS was_in,
      s.new_channel_id IS NOT DISTINCT FROM s.office_channel_id AS is_in
  ) AS place
  CROSS JOIN LATERAL (
    VALUES
      (CASE
        WHEN s.source = 'startup' THEN 'AlreadyThere'
        WHEN NOT place.was_in AND place.is_in THEN 'Joined'
      END),
      ${flagEvents.join(",\n      ")},
      (CASE WHEN place.was_in AND NOT place.is_in THEN 'Left' END)
  ) AS e(event)
  WHERE e.event IS NOT NULL
`;

const officeActivityView = `
  CREATE VIEW office.office_activity AS
  SELECT
    observed_at,
    bot_session_id,
    user_id,
    display_name,
    real_name,
    event,
    NULL::text AS detail,
    snapshot_id,
    NULL::bigint AS effect_id
  FROM office.voice_activity
  UNION ALL
  SELECT
    e.observed_at,
    e.bot_session_id,
    e.user_id,
    m.display_name,
    m.real_name,
    CASE
      WHEN e.sound_id IS NOT NULL THEN 'PlayedSound'
      WHEN e.emoji_id IS NOT NULL OR e.emoji_name IS NOT NULL THEN 'Reacted'
      ELSE 'SentEffect'
    END,
    CASE WHEN e.sound_id IS NOT NULL THEN e.sound_name ELSE e.emoji_name END,
    NULL::bigint,
    e.id
  FROM office.voice_effects e
  JOIN office.members m USING (user_id)
`;

// Keyed `<id>_<name>` and run once each, in id order, inside the `office`
// schema. They only ever add: nothing stored is ever deleted. Inlined rather
// than read from disk, because the VM only gets the bundled main.js.
export const migrations = Migrator.fromRecord({
  "0001_record_voice_activity": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    // One row per run of the bot, so "nobody was in the office" can be told
    // apart from "the bot wasn't watching". `stopped_at` stays null when it
    // didn't stop cleanly.
    yield* sql`
      CREATE TABLE office.bot_sessions (
        id uuid PRIMARY KEY,
        started_at timestamptz NOT NULL,
        stopped_at timestamptz
      )
    `;

    // The bot only ever writes `display_name` and `last_seen_at`. `real_name`
    // is filled in by hand.
    yield* sql`
      CREATE TABLE office.members (
        user_id text PRIMARY KEY,
        display_name text NOT NULL,
        real_name text,
        first_seen_at timestamptz NOT NULL,
        last_seen_at timestamptz NOT NULL
      )
    `;

    // Voice states as Discord sent them, before and after each update touching
    // the office. `startup` rows are people already there when the bot started.
    // `entry_id` is set by the bot, so a retried write is only stored once.
    yield* sql`
      CREATE TABLE office.voice_snapshots (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        entry_id uuid NOT NULL UNIQUE,
        bot_session_id uuid NOT NULL REFERENCES office.bot_sessions (id),
        source text NOT NULL CHECK (source IN ('update', 'startup')),
        observed_at timestamptz NOT NULL,
        guild_id text NOT NULL,
        office_channel_id text NOT NULL,
        user_id text NOT NULL REFERENCES office.members (user_id),
        old_channel_id text,
        new_channel_id text,
        old_self_mute boolean,
        new_self_mute boolean,
        old_self_deaf boolean,
        new_self_deaf boolean,
        old_server_mute boolean,
        new_server_mute boolean,
        old_server_deaf boolean,
        new_server_deaf boolean,
        old_self_video boolean,
        new_self_video boolean,
        old_streaming boolean,
        new_streaming boolean,
        old_suppress boolean,
        new_suppress boolean,
        old_request_to_speak_at timestamptz,
        new_request_to_speak_at timestamptz,
        old_session_id text,
        new_session_id text
      )
    `;

    yield* sql`CREATE INDEX voice_snapshots_observed_at ON office.voice_snapshots (observed_at)`;
    yield* sql`CREATE INDEX voice_snapshots_user_id_observed_at ON office.voice_snapshots (user_id, observed_at)`;

    // Updates that could never be written, kept so they can be replayed by hand.
    yield* sql`
      CREATE TABLE office.rejected_updates (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        rejected_at timestamptz NOT NULL,
        payload jsonb NOT NULL,
        error text NOT NULL
      )
    `;

    yield* sql.unsafe(voiceActivityView);
  }),

  "0002_record_banter_posts": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE office.banter_posts (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        posted_at timestamptz NOT NULL,
        period text NOT NULL
      )
    `;

    yield* sql`CREATE INDEX banter_posts_posted_at ON office.banter_posts (posted_at)`;
  }),

  "0003_record_voice_effects": Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;

    yield* sql`
      CREATE TABLE office.voice_effects (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        entry_id uuid NOT NULL UNIQUE,
        bot_session_id uuid NOT NULL REFERENCES office.bot_sessions (id),
        observed_at timestamptz NOT NULL,
        guild_id text NOT NULL,
        channel_id text NOT NULL,
        user_id text NOT NULL REFERENCES office.members (user_id),
        sound_id text,
        sound_name text,
        sound_volume double precision,
        emoji_id text,
        emoji_name text,
        emoji_animated boolean,
        animation_type integer,
        animation_id integer
      )
    `;

    yield* sql`CREATE INDEX voice_effects_observed_at ON office.voice_effects (observed_at)`;
    yield* sql`CREATE INDEX voice_effects_user_id_observed_at ON office.voice_effects (user_id, observed_at)`;

    yield* sql.unsafe(officeActivityView);
  }),
});
