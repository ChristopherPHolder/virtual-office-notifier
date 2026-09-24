import { Data, Option } from "effect";

export interface OfficeMember {
  readonly userId: string;
  readonly displayName: string;
  readonly guildId: string;
  readonly channelId: string;
}

export type OfficeEvent = Data.TaggedEnum<{
  Joined: OfficeMember;
  Left: OfficeMember;
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

export const toOfficeEvent = (
  officeChannelId: string,
  update: VoiceStateUpdate,
): Option.Option<OfficeEvent> => {
  const member: OfficeMember = {
    userId: update.userId,
    displayName: update.displayName,
    guildId: update.guildId,
    channelId: officeChannelId,
  };

  if (isOfficeJoin(officeChannelId, update)) return Option.some(OfficeEvent.Joined(member));

  if (isOfficeLeave(officeChannelId, update)) return Option.some(OfficeEvent.Left(member));

  return Option.none();
};
