import { describe, expect, it } from "vitest";

import { isOfficeJoin } from "../src/VoiceJoin.ts";

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
