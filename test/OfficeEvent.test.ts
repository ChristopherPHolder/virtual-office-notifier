import { describe, expect, it } from "vitest";

import { Option } from "effect";

import { isOfficeJoin, isOfficeLeave, OfficeEvent, toOfficeEvent } from "../src/OfficeEvent.ts";

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

describe("toOfficeEvent", () => {
  const update = { userId: "u1", displayName: "Ada", guildId: "g1", isBot: false };
  const member = { userId: "u1", displayName: "Ada", guildId: "g1", channelId: OFFICE };

  it("maps a join", () => {
    expect(toOfficeEvent(OFFICE, { ...update, oldChannelId: null, newChannelId: OFFICE })).toEqual(
      Option.some(OfficeEvent.Joined(member)),
    );
  });

  it("maps a leave to the office channel", () => {
    expect(toOfficeEvent(OFFICE, { ...update, oldChannelId: OFFICE, newChannelId: "lobby" })).toEqual(
      Option.some(OfficeEvent.Left(member)),
    );
  });

  it("drops everything else", () => {
    expect(toOfficeEvent(OFFICE, { ...update, oldChannelId: OFFICE, newChannelId: OFFICE })).toEqual(
      Option.none(),
    );
  });
});
