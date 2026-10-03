import { type Array, DateTime, Duration, Effect, Filter, identity, Option, Random, Stream } from "effect";

import { type BanterContext, type BanterPeriod, OfficeEvent, type OfficeLocation } from "./OfficeEvent.ts";
import { OfficeHistory } from "./OfficeHistory.ts";
import { OFFICE_TIME_ZONE } from "./Reminder.ts";

export const MAX_BANTER_PER_DAY = 5;

export const BANTER_HOURS = { from: 9, until: 18 };

export const MINUTES_BETWEEN_CHANCES = { min: 60, max: 150 };

export const BANTER_PERIODS: Array.NonEmptyReadonlyArray<BanterPeriod> = [
  "Today",
  "SinceYesterday",
  "ThisWeek",
  "LastWeek",
];

const inOfficeTime = (at: DateTime.Utc): DateTime.Zoned => DateTime.setZone(at, OFFICE_TIME_ZONE);

const MONDAY = 1;

const FRIDAY = 5;

export const isBanterTime = (at: DateTime.Utc): boolean => {
  const { weekDay, hour } = DateTime.toParts(inOfficeTime(at));

  return weekDay >= MONDAY && weekDay <= FRIDAY && hour >= BANTER_HOURS.from && hour < BANTER_HOURS.until;
};

export const startOfOfficeDay = (at: DateTime.Utc): DateTime.Utc =>
  DateTime.toUtc(DateTime.startOf(inOfficeTime(at), "day"));

const startOfOfficeWeek = (at: DateTime.Utc): DateTime.Utc =>
  DateTime.toUtc(DateTime.startOf(inOfficeTime(at), "week", { weekStartsOn: MONDAY }));

export interface PeriodRange {
  readonly from: DateTime.Utc;
  readonly until: DateTime.Utc;
  readonly description: string;
}

export const periodRange = (period: BanterPeriod, at: DateTime.Utc): PeriodRange => {
  switch (period) {
    case "Today":
      return { from: startOfOfficeDay(at), until: at, description: "today so far" };
    case "SinceYesterday":
      return {
        from: DateTime.subtract(startOfOfficeDay(at), { days: 1 }),
        until: at,
        description: "yesterday and today so far",
      };
    case "ThisWeek":
      return { from: startOfOfficeWeek(at), until: at, description: "this week so far" };
    case "LastWeek":
      return {
        from: DateTime.subtract(startOfOfficeWeek(at), { weeks: 1 }),
        until: startOfOfficeWeek(at),
        description: "last week",
      };
  }
};

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const twoDigits = (value: number): string => String(value).padStart(2, "0");

export const officeClock = (at: DateTime.Utc): string => {
  const { weekDay, day, month, hour, minute } = DateTime.toParts(inOfficeTime(at));

  return `${WEEKDAY_NAMES[weekDay]} ${day} ${MONTH_NAMES[month - 1]} ${twoDigits(hour)}:${twoDigits(minute)}`;
};

const whoIsPresent = (present: ReadonlyArray<string>): string =>
  present.length === 0 ? "Nobody's in the office right now." : `In the office right now: ${present.join(", ")}.`;

const activityHeading = (context: BanterContext, description: string): string =>
  context.olderEntriesLeftOut === 0
    ? `Here's everything that happened in the office ${description}, with times in UTC+2:`
    : `Here are the latest ${context.activityOldestFirst.length} things that happened in the office ${description}, with times in UTC+2. ${context.olderEntriesLeftOut} earlier ones are left out:`;

export const banterLog = (context: BanterContext): string => {
  const { description } = periodRange(context.period, context.at);

  return [
    `It's ${officeClock(context.at)} (UTC+2).`,
    whoIsPresent(context.present),
    ...(context.activityOldestFirst.length === 0
      ? [`Nothing happened in the office ${description}.`]
      : [
          activityHeading(context, description),
          ...context.activityOldestFirst.map(({ at, who, event }) => `${officeClock(at)} ${who} ${event}`),
        ]),
  ].join("\n");
};

const waitForNextChance = Random.nextIntBetween(MINUTES_BETWEEN_CHANCES.min, MINUTES_BETWEEN_CHANCES.max).pipe(
  Effect.flatMap((minutes) => Effect.sleep(Duration.minutes(minutes))),
);

const nextBanter = Effect.fn("Banter.next")(
  function* (office: OfficeLocation) {
    const history = yield* OfficeHistory;
    const at = yield* DateTime.now;

    if (!isBanterTime(at)) return Option.none<OfficeEvent>();

    const postedToday = yield* history.banterPostsSince(startOfOfficeDay(at));

    if (postedToday >= MAX_BANTER_PER_DAY) {
      yield* Effect.logInfo("Skipped banter, there's been enough today").pipe(Effect.annotateLogs({ postedToday }));

      return Option.none<OfficeEvent>();
    }

    const period = yield* Random.choice(BANTER_PERIODS);
    const { from, until } = periodRange(period, at);
    const { entriesOldestFirst, olderEntriesLeftOut } = yield* history.latestActivityBetween(from, until);
    const present = yield* history.presentSinceBotStarted;

    yield* history.recordBanterPost(at, period);

    return Option.some(
      OfficeEvent.Banter({ ...office, at, period, activityOldestFirst: entriesOldestFirst, olderEntriesLeftOut, present }),
    );
  },
  Effect.catchTag("HistoryUnavailable", (error) =>
    Effect.logWarning("Skipped banter, couldn't read the office history").pipe(
      Effect.annotateLogs({ reason: error.reason }),
      Effect.as(Option.none<OfficeEvent>()),
    ),
  ),
);

export const banter = (office: OfficeLocation): Stream.Stream<OfficeEvent, never, OfficeHistory> =>
  Stream.fromEffectRepeat(waitForNextChance.pipe(Effect.andThen(nextBanter(office)))).pipe(
    Stream.filterMap(Filter.fromPredicateOption(identity)),
  );
