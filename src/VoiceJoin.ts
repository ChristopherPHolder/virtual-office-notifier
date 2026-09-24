export interface VoiceJoin {
  readonly userId: string;
  readonly displayName: string;
  readonly guildId: string;
  readonly channelId: string;
}

export interface VoiceStateChange {
  readonly oldChannelId: string | null;
  readonly newChannelId: string | null;
  readonly isBot: boolean;
}

// Mute, deafen and video updates keep the same channel on both sides, so
// comparing channel IDs is enough to ignore them.
export const isOfficeJoin = (
  officeChannelId: string,
  change: VoiceStateChange,
): boolean =>
  !change.isBot &&
  change.newChannelId === officeChannelId &&
  change.oldChannelId !== officeChannelId;
