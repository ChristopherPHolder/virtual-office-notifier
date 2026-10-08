import { Filter, Result } from "effect";

import { OfficeEvent, type Occupants } from "./OfficeEvent.ts";

export type BotPresence = "InOffice" | "Away";

export const presenceAtStartup = (occupants: Occupants): BotPresence => (occupants.size > 0 ? "InOffice" : "Away");

const presenceAfterEvent = OfficeEvent.$match({
  Opened: (): Result.Result<BotPresence, OfficeEvent> => Result.succeed("InOffice"),
  Emptied: (): Result.Result<BotPresence, OfficeEvent> => Result.succeed("Away"),
  Reminder: (event): Result.Result<BotPresence, OfficeEvent> => Result.fail(event),
  Banter: (event): Result.Result<BotPresence, OfficeEvent> => Result.fail(event),
});

export const presenceAfter = Filter.make(presenceAfterEvent);
