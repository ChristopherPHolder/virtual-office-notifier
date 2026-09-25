import { describe, expect, it } from "vitest";

import { isOfficeJoin, isOfficeLeave, OfficeEvent, trackOccupancy } from "../src/OfficeEvent.ts";

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
  const update = { userId: "u1", displayName: "Ada", guildId: "g1", isBot: false };
  const member = { userId: "u1", displayName: "Ada", guildId: "g1", channelId: OFFICE };
  const join = { ...update, oldChannelId: null, newChannelId: OFFICE };
  const leave = { ...update, oldChannelId: OFFICE, newChannelId: "lobby" };

  it("opens the office when the first person joins", () => {
    expect(step(new Set(), join)).toEqual([new Set(["u1"]), [OfficeEvent.Opened(member)]]);
  });

  it("stays quiet when someone joins an occupied office", () => {
    expect(step(new Set(["u2"]), join)).toEqual([new Set(["u2", "u1"]), []]);
  });

  it("closes the office when the last person leaves", () => {
    expect(step(new Set(["u1"]), leave)).toEqual([new Set(), [OfficeEvent.Closed(member)]]);
  });

  it("stays quiet when someone leaves and others remain", () => {
    expect(step(new Set(["u1", "u2"]), leave)).toEqual([new Set(["u2"]), []]);
  });

  it("ignores a duplicate join", () => {
    expect(step(new Set(["u1"]), join)).toEqual([new Set(["u1"]), []]);
  });

  it("ignores a leave from someone it never saw join", () => {
    expect(step(new Set(), leave)).toEqual([new Set(), []]);
  });

  it("ignores changes inside the office", () => {
    expect(step(new Set(["u1"]), { ...update, oldChannelId: OFFICE, newChannelId: OFFICE })).toEqual([
      new Set(["u1"]),
      [],
    ]);
  });
});
