import { Filter, Result } from "effect";

import type { TimedVoiceStateUpdate } from "./OfficeEvent.ts";

// "update" is a voice state change Discord sent. "startup" is someone already
// in the office when the bot connected, whose arrival it didn't see.
export type ObservationSource = "update" | "startup";

// A voice state update worth recording, with the office it was recorded for.
export interface VoiceObservation extends TimedVoiceStateUpdate {
  readonly source: ObservationSource;
  readonly officeChannelId: string;
}

// Anything touching the office: arriving, leaving, moving in or out, and every
// change while inside. Bots are left out.
export const observe = (officeChannelId: string) =>
  Filter.make(
    (update: TimedVoiceStateUpdate): Result.Result<VoiceObservation, TimedVoiceStateUpdate> =>
      !update.isBot && (update.oldChannelId === officeChannelId || update.newChannelId === officeChannelId)
        ? Result.succeed({ ...update, source: "update", officeChannelId })
        : Result.fail(update),
  );
