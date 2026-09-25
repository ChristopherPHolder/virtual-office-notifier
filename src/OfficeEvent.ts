import { Data } from "effect";

// Where the office voice channel lives, enough to build a join link.
export interface OfficeLocation {
  readonly guildId: string;
  readonly channelId: string;
}

export interface OfficeMember extends OfficeLocation {
  readonly userId: string;
  readonly displayName: string;
}

// Only the edges of a session are announced: the first person in opens the
// office, and the last person out leaves it empty. Reminders come from a
// schedule rather than from Discord.
export type OfficeEvent = Data.TaggedEnum<{
  Opened: OfficeMember;
  Emptied: OfficeMember;
  Reminder: OfficeLocation;
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

// A plain snapshot of a discord.js voiceStateUpdate event.
export interface VoiceStateUpdate extends VoiceStateChange {
  readonly userId: string;
  readonly displayName: string;
  readonly guildId: string;
}

// User IDs of the people currently in the office, bots excluded.
export type Occupants = ReadonlySet<string>;

const unchanged = (occupants: Occupants): readonly [Occupants, ReadonlyArray<OfficeEvent>] => [occupants, []];

// Steps the office occupancy by one voice state update. A join or leave we have
// already accounted for (e.g. a duplicate event) changes nothing.
export const trackOccupancy =
  (officeChannelId: string) =>
  (occupants: Occupants, update: VoiceStateUpdate): readonly [Occupants, ReadonlyArray<OfficeEvent>] => {
    const member: OfficeMember = {
      userId: update.userId,
      displayName: update.displayName,
      guildId: update.guildId,
      channelId: officeChannelId,
    };

    if (isOfficeJoin(officeChannelId, update)) {
      if (occupants.has(update.userId)) return unchanged(occupants);

      const next = new Set(occupants).add(update.userId);

      return [next, occupants.size === 0 ? [OfficeEvent.Opened(member)] : []];
    }

    if (isOfficeLeave(officeChannelId, update)) {
      if (!occupants.has(update.userId)) return unchanged(occupants);

      const next = new Set(occupants);
      next.delete(update.userId);

      return [next, next.size === 0 ? [OfficeEvent.Emptied(member)] : []];
    }

    return unchanged(occupants);
  };
