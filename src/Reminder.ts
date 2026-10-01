import { Cron, DateTime, Effect, Schedule, Stream } from "effect";

import { OfficeEvent, type OfficeLocation } from "./OfficeEvent.ts";

// Weekdays at 11:15 UTC+2. A fixed offset, so it doesn't follow daylight saving.
const reminderCron = Cron.make({
  minutes: [15],
  hours: [11],
  days: [],
  months: [],
  weekdays: [1, 2, 3, 4, 5],
  tz: DateTime.zoneMakeOffset(2 * 60 * 60 * 1000),
});

export const reminders = (office: OfficeLocation): Stream.Stream<OfficeEvent> =>
  Stream.fromSchedule(Schedule.cron(reminderCron)).pipe(
    // Only a cron string can fail to parse, and this one is already built.
    Stream.orDie,
    Stream.mapEffect(() => Effect.map(DateTime.now, (at) => OfficeEvent.Reminder({ ...office, at }))),
  );
