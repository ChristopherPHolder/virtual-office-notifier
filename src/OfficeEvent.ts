import { Data, DateTime, type Duration, Option } from "effect";

// Where the office voice channel lives, enough to build a join link.
export interface OfficeLocation {
  readonly guildId: string;
  readonly channelId: string;
}

export interface OfficeMember extends OfficeLocation {
  readonly userId: string;
  readonly displayName: string;
  // Null when Discord didn't send the member with the update.
  readonly avatarUrl: string | null;
}

// How a session went, for the message when the office empties.
export interface SessionRecap {
  readonly duration: Duration.Duration;
  readonly visitors: number;
}

// Only the edges of a session are announced: the first person in opens the
// office, and the last person out leaves it empty. Reminders come from a
// schedule rather than from Discord.
export type OfficeEvent = Data.TaggedEnum<{
  Opened: OfficeMember & { readonly at: DateTime.Utc };
  // No recap when the session was already under way at startup, since we
  // missed how it started.
  Emptied: OfficeMember & { readonly at: DateTime.Utc; readonly recap: Option.Option<SessionRecap> };
  Reminder: OfficeLocation & { readonly at: DateTime.Utc };
}>;

export const OfficeEvent = Data.taggedEnum<OfficeEvent>();

export interface VoiceStateChange {
  readonly oldChannelId: string | null;
  readonly newChannelId: string | null;
  readonly isBot: boolean;
}

// Mute, deafen and video updates keep the same channel on both sides, so
// comparing channel IDs is enough to ignore them.
export const isOfficeJoin = (officeChannelId: string, change: VoiceStateChange): boolean =>
  !change.isBot &&
  change.newChannelId === officeChannelId &&
  change.oldChannelId !== officeChannelId;

// Covers both disconnecting and moving to another voice channel.
export const isOfficeLeave = (officeChannelId: string, change: VoiceStateChange): boolean =>
  !change.isBot &&
  change.oldChannelId === officeChannelId &&
  change.newChannelId !== officeChannelId;

// Everything else on one side of a voice state, recorded as Discord sent it.
// Null when Discord didn't say, as on the old side of a join.
export interface VoiceDetails {
  readonly selfMute: boolean | null;
  readonly selfDeaf: boolean | null;
  readonly serverMute: boolean | null;
  readonly serverDeaf: boolean | null;
  readonly selfVideo: boolean | null;
  readonly streaming: boolean | null;
  readonly suppress: boolean | null;
  readonly requestToSpeakAt: DateTime.Utc | null;
  readonly sessionId: string | null;
}

export const NO_VOICE_DETAILS: VoiceDetails = {
  selfMute: null,
  selfDeaf: null,
  serverMute: null,
  serverDeaf: null,
  selfVideo: null,
  streaming: null,
  suppress: null,
  requestToSpeakAt: null,
  sessionId: null,
};

// A plain snapshot of a discord.js voiceStateUpdate event.
export interface VoiceStateUpdate extends VoiceStateChange {
  readonly userId: string;
  readonly displayName: string;
  readonly avatarUrl: string | null;
  readonly guildId: string;
  readonly oldDetails: VoiceDetails;
  readonly newDetails: VoiceDetails;
}

// A voice state update stamped with when it arrived.
export type TimedVoiceStateUpdate = VoiceStateUpdate & { readonly at: DateTime.Utc };

// User IDs of the people currently in the office, bots excluded.
export type Occupants = ReadonlySet<string>;

export interface OfficeSession {
  readonly occupants: Occupants;
  // Everyone who has been in since the office opened, including who's in now.
  readonly visitors: ReadonlySet<string>;
  // None while the office is empty, or when the session started before we did.
  readonly openedAt: Option.Option<DateTime.Utc>;
}

// Whoever is in at startup joined before we were watching, so their session
// gets no recap.
export const sessionOf = (occupants: Occupants): OfficeSession => ({
  occupants,
  visitors: occupants,
  openedAt: Option.none(),
});

const unchanged = (session: OfficeSession): readonly [OfficeSession, ReadonlyArray<OfficeEvent>] => [session, []];

// Steps the office session by one voice state update. A join or leave we have
// already accounted for (e.g. a duplicate event) changes nothing.
export const trackOccupancy =
  (officeChannelId: string) =>
  (
    session: OfficeSession,
    update: TimedVoiceStateUpdate,
  ): readonly [OfficeSession, ReadonlyArray<OfficeEvent>] => {
    const { occupants } = session;

    const member: OfficeMember = {
      userId: update.userId,
      displayName: update.displayName,
      avatarUrl: update.avatarUrl,
      guildId: update.guildId,
      channelId: officeChannelId,
    };

    if (isOfficeJoin(officeChannelId, update)) {
      if (occupants.has(update.userId)) return unchanged(session);

      const next = new Set(occupants).add(update.userId);

      if (occupants.size === 0) {
        return [
          { occupants: next, visitors: new Set([update.userId]), openedAt: Option.some(update.at) },
          [OfficeEvent.Opened({ ...member, at: update.at })],
        ];
      }

      return [{ ...session, occupants: next, visitors: new Set(session.visitors).add(update.userId) }, []];
    }

    if (isOfficeLeave(officeChannelId, update)) {
      if (!occupants.has(update.userId)) return unchanged(session);

      const next = new Set(occupants);
      next.delete(update.userId);

      if (next.size > 0) return [{ ...session, occupants: next }, []];

      const recap = Option.map(session.openedAt, (openedAt) => ({
        duration: DateTime.distance(openedAt, update.at),
        visitors: session.visitors.size,
      }));

      return [sessionOf(next), [OfficeEvent.Emptied({ ...member, at: update.at, recap })]];
    }

    return unchanged(session);
  };
