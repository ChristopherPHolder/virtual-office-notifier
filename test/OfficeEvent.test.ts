import { DateTime, Duration, Option } from "effect";
import { describe, expect, it } from "vitest";

import {
  isOfficeJoin,
  isOfficeLeave,
  NO_VOICE_DETAILS,
  OfficeEvent,
  type OfficeSession,
  sessionOf,
  type TimedVoiceStateUpdate,
  trackOccupancy,
} from "../src/OfficeEvent.ts";

const OFFICE = "office";

describe("isOfficeJoin", () => {
  it("accepts a join from outside voice", () => {
    expect(
      isOfficeJoin(OFFICE, { oldChannelId: null, newChannelId: OFFICE, isBot: false }),
    ).toBe(true);
  });

  it("accepts a move from another voice channel", () => {
    expect(
      isOfficeJoin(OFFICE, { oldChannelId: "lobby", newChannelId: OFFICE, isBot: false }),
    ).toBe(true);
  });

  it("ignores mute, deafen and video updates inside the office", () => {
    expect(
      isOfficeJoin(OFFICE, { oldChannelId: OFFICE, newChannelId: OFFICE, isBot: false }),
    ).toBe(false);
  });

  it("ignores bots", () => {
    expect(
      isOfficeJoin(OFFICE, { oldChannelId: null, newChannelId: OFFICE, isBot: true }),
    ).toBe(false);
  });

  it("ignores joins to other voice channels", () => {
    expect(
      isOfficeJoin(OFFICE, { oldChannelId: null, newChannelId: "lobby", isBot: false }),
    ).toBe(false);
  });

  it("ignores leaving the office", () => {
    expect(
      isOfficeJoin(OFFICE, { oldChannelId: OFFICE, newChannelId: null, isBot: false }),
    ).toBe(false);
  });
});

describe("isOfficeLeave", () => {
  it("accepts disconnecting from the office", () => {
    expect(
      isOfficeLeave(OFFICE, { oldChannelId: OFFICE, newChannelId: null, isBot: false }),
    ).toBe(true);
  });

  it("accepts moving from the office to another voice channel", () => {
    expect(
      isOfficeLeave(OFFICE, { oldChannelId: OFFICE, newChannelId: "lobby", isBot: false }),
    ).toBe(true);
  });

  it("ignores mute, deafen and video updates inside the office", () => {
    expect(
      isOfficeLeave(OFFICE, { oldChannelId: OFFICE, newChannelId: OFFICE, isBot: false }),
    ).toBe(false);
  });

  it("ignores bots", () => {
    expect(
      isOfficeLeave(OFFICE, { oldChannelId: OFFICE, newChannelId: null, isBot: true }),
    ).toBe(false);
  });

  it("ignores leaving other voice channels", () => {
    expect(
      isOfficeLeave(OFFICE, { oldChannelId: "lobby", newChannelId: null, isBot: false }),
    ).toBe(false);
  });
});

describe("trackOccupancy", () => {
  const step = trackOccupancy(OFFICE);
  const t0 = DateTime.makeUnsafe(0);
  const later = (minutes: number) => DateTime.add(t0, { minutes });

  const update = {
    userId: "u1",
    displayName: "Ada",
    avatarUrl: null,
    guildId: "g1",
    isBot: false,
    oldDetails: NO_VOICE_DETAILS,
    newDetails: NO_VOICE_DETAILS,
    at: t0,
  };

  const member = { userId: "u1", displayName: "Ada", avatarUrl: null, guildId: "g1", channelId: OFFICE };
  const join = { ...update, oldChannelId: null, newChannelId: OFFICE };
  const leave = { ...update, oldChannelId: OFFICE, newChannelId: "lobby" };
  const empty = sessionOf(new Set());

  // Runs a sequence of updates from an empty office and collects every event.
  const run = (updates: ReadonlyArray<TimedVoiceStateUpdate>, start: OfficeSession = empty) =>
    updates.reduce<[OfficeSession, Array<OfficeEvent>]>(
      ([session, events], next) => {
        const [after, emitted] = step(session, next);

        return [after, [...events, ...emitted]];
      },
      [start, []],
    );

  it("opens the office when the first person joins", () => {
    expect(step(empty, join)).toEqual([
      { occupants: new Set(["u1"]), visitors: new Set(["u1"]), openedAt: Option.some(t0) },
      [OfficeEvent.Opened({ ...member, at: t0 })],
    ]);
  });

  it("stays quiet when someone joins an occupied office", () => {
    const [session, events] = run([{ ...join, userId: "u2" }, join]);

    expect(session.occupants).toEqual(new Set(["u2", "u1"]));
    expect(events).toHaveLength(1);
  });

  it("reports the office empty with a recap when the last person leaves", () => {
    const [, events] = run([
      join,
      { ...join, userId: "u2", at: later(10) },
      { ...leave, userId: "u2", at: later(20) },
      { ...leave, at: later(134) },
    ]);

    expect(events.at(-1)).toEqual(
      OfficeEvent.Emptied({
        ...member,
        at: later(134),
        recap: Option.some({ duration: Duration.minutes(134), visitors: 2 }),
      }),
    );
  });

  it("counts someone who comes back once", () => {
    const [, events] = run([join, { ...join, userId: "u2" }, leave, join, { ...leave, userId: "u2" }, leave]);

    expect(events.at(-1)).toMatchObject({ recap: Option.some({ visitors: 2 }) });
  });

  it("starts a fresh recap for the next session", () => {
    const [, events] = run([
      { ...join, userId: "u2" },
      { ...leave, userId: "u2", at: later(5) },
      { ...join, at: later(60) },
      { ...leave, at: later(90) },
    ]);

    expect(events.at(-1)).toMatchObject({ recap: Option.some({ duration: Duration.minutes(30), visitors: 1 }) });
  });

  it("gives no recap for a session already under way at startup", () => {
    expect(step(sessionOf(new Set(["u1"])), leave)).toEqual([
      empty,
      [OfficeEvent.Emptied({ ...member, at: t0, recap: Option.none() })],
    ]);
  });

  it("stays quiet when someone leaves and others remain", () => {
    const [session, events] = step(sessionOf(new Set(["u1", "u2"])), leave);

    expect(session.occupants).toEqual(new Set(["u2"]));
    expect(events).toEqual([]);
  });

  it("ignores a duplicate join", () => {
    const occupied = sessionOf(new Set(["u1"]));

    expect(step(occupied, join)).toEqual([occupied, []]);
  });

  it("ignores a leave from someone it never saw join", () => {
    expect(step(empty, leave)).toEqual([empty, []]);
  });

  it("ignores changes inside the office", () => {
    const occupied = sessionOf(new Set(["u1"]));

    expect(step(occupied, { ...update, oldChannelId: OFFICE, newChannelId: OFFICE })).toEqual([occupied, []]);
  });
});
