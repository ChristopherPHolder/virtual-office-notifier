import { DateTime } from "effect";

import type { ActivityEntry, BanterContext } from "../src/OfficeEvent.ts";

export interface BanterScenario extends BanterContext {
  readonly name: string;
}

const officeTime = (day: string, time: string) => DateTime.makeUnsafe(`${day}T${time}:00+02:00`);

const happenedOn = (day: string, lines: string): ReadonlyArray<ActivityEntry> =>
  lines
    .trim()
    .split("\n")
    .map((line) => {
      const [time = "", who = "", ...event] = line.trim().split(/\s+/);

      return { at: officeTime(day, time), who, event: event.join(" ") };
    });

const MON = "2026-09-28";

const TUE = "2026-09-29";

const WED = "2026-09-30";

const THU = "2026-10-01";

const FRI = "2026-10-02";

const NEXT_MON = "2026-10-05";

const muteMarathon = Array.from({ length: 8 }, (_, index) => {
  const minute = String(10 + index * 6).padStart(2, "0");
  const later = String(12 + index * 6).padStart(2, "0");

  return `10:${minute} Linus Unmuted\n10:${later} Linus Muted`;
}).join("\n");

const loneWeek = [MON, TUE, WED, THU]
  .flatMap((day) => happenedOn(day, "09:01 Margaret Joined\n12:30 Margaret Left\n13:15 Margaret Joined\n17:32 Margaret Left"))
  .concat(happenedOn(FRI, "08:58 Margaret Joined"));

const earlyBirds = [
  [MON, "07:12"],
  [TUE, "07:05"],
  [WED, "06:58"],
  [THU, "07:20"],
  [FRI, "07:01"],
].flatMap(([day = MON, time = "07:00"]) =>
  happenedOn(day, `${time} Ada Joined\n09:34 Grace Joined\n09:41 Alan Joined\n16:02 Ada Left\n17:45 Grace Left\n18:10 Alan Left`),
);

export const banterScenarios: ReadonlyArray<BanterScenario> = [
  {
    name: "busy-friday",
    at: officeTime(FRI, "14:05"),
    period: "Today",
    activityOldestFirst: happenedOn(
      FRI,
      `
      08:47 Ada Joined
      09:03 Linus Joined
      09:03 Linus Muted
      09:30 Grace Joined
      09:31 Grace CameraOn
      09:34 Grace CameraOff
      10:12 Alan Joined
      10:15 Alan StreamStarted
      10:52 Alan StreamStopped
      11:00 Barbara Joined
      11:05 Barbara Left
      12:30 Grace Left
      13:20 Grace Joined
      `,
    ),
    olderEntriesLeftOut: 0,
    present: ["Ada", "Alan", "Grace", "Linus"],
  },
  {
    name: "ghost-town",
    at: officeTime(FRI, "11:40"),
    period: "SinceYesterday",
    activityOldestFirst: [],
    olderEntriesLeftOut: 0,
    present: [],
  },
  {
    name: "mute-marathon",
    at: officeTime(THU, "11:20"),
    period: "Today",
    activityOldestFirst: happenedOn(THU, `09:15 Ada Joined\n09:40 Linus Joined\n09:40 Linus Muted\n${muteMarathon}`),
    olderEntriesLeftOut: 0,
    present: ["Ada", "Linus"],
  },
  {
    name: "lone-regular",
    at: officeTime(FRI, "15:30"),
    period: "ThisWeek",
    activityOldestFirst: loneWeek,
    olderEntriesLeftOut: 0,
    present: ["Margaret"],
  },
  {
    name: "early-bird",
    at: officeTime(NEXT_MON, "10:20"),
    period: "LastWeek",
    activityOldestFirst: earlyBirds,
    olderEntriesLeftOut: 0,
    present: ["Ada", "Grace"],
  },
  {
    name: "camera-party",
    at: officeTime(THU, "16:45"),
    period: "ThisWeek",
    activityOldestFirst: happenedOn(
      WED,
      `
      14:50 Barbara Joined
      14:52 Alan Joined
      14:55 Grace Joined
      14:58 Linus Joined
      15:00 Barbara CameraOn
      15:00 Alan CameraOn
      15:01 Grace CameraOn
      15:01 Linus CameraOn
      15:03 Alan PlayedSound airhorn
      15:03 Grace Reacted 😂
      15:04 Alan PlayedSound airhorn
      15:20 Linus Deafened
      15:20 Linus Muted
      15:24 Linus Undeafened
      15:24 Linus Unmuted
      15:40 Alan CameraOff
      15:41 Grace CameraOff
      15:41 Linus CameraOff
      15:42 Barbara CameraOff
      16:30 Alan Left
      16:31 Grace Left
      16:31 Linus Left
      `,
    ).concat(happenedOn(THU, "09:20 Barbara Joined")),
    olderEntriesLeftOut: 0,
    present: ["Barbara"],
  },
];
