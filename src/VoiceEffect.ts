import { type DateTime, Filter, Result } from "effect";

export interface VoiceEffect {
  readonly userId: string;
  readonly displayName: string;
  readonly isBot: boolean;
  readonly guildId: string;
  readonly channelId: string;
  readonly soundId: string | null;
  readonly soundName: string | null;
  readonly soundVolume: number | null;
  readonly emojiId: string | null;
  readonly emojiName: string | null;
  readonly emojiAnimated: boolean | null;
  readonly animationType: number | null;
  readonly animationId: number | null;
}

export type TimedVoiceEffect = VoiceEffect & { readonly at: DateTime.Utc };

export const sentInOffice = (officeChannelId: string) =>
  Filter.make(
    (effect: TimedVoiceEffect): Result.Result<TimedVoiceEffect, TimedVoiceEffect> =>
      !effect.isBot && effect.channelId === officeChannelId ? Result.succeed(effect) : Result.fail(effect),
  );
