import { DateTime, Result } from "effect";
import { describe, expect, it } from "vitest";

import { NO_VOICE_DETAILS, type TimedVoiceStateUpdate } from "../src/OfficeEvent.ts";
import { observe } from "../src/VoiceObservation.ts";

const OFFICE = "office";

const update = (overrides: Partial<TimedVoiceStateUpdate> = {}): TimedVoiceStateUpdate => ({
  userId: "u1",
  displayName: "Ada",
  avatarUrl: null,
  guildId: "g1",
  isBot: false,
  oldChannelId: OFFICE,
  newChannelId: OFFICE,
  oldDetails: NO_VOICE_DETAILS,
  newDetails: NO_VOICE_DETAILS,
  at: DateTime.makeUnsafe(0),
  ...overrides,
});

const observed = (change: TimedVoiceStateUpdate) => Result.isSuccess(observe(OFFICE)(change));

describe("observe", () => {
  it("keeps anything touching the office: joins, leaves, moves and changes inside", () => {
    expect(observed(update({ oldChannelId: null }))).toBe(true);
    expect(observed(update({ newChannelId: null }))).toBe(true);
    expect(observed(update({ oldChannelId: "lobby" }))).toBe(true);
    expect(observed(update({ newChannelId: "lobby" }))).toBe(true);
    expect(observed(update())).toBe(true);
  });

  it("leaves out other channels and bots", () => {
    expect(observed(update({ oldChannelId: "lobby", newChannelId: "lobby" }))).toBe(false);
    expect(observed(update({ oldChannelId: null, newChannelId: "lobby" }))).toBe(false);
    expect(observed(update({ isBot: true }))).toBe(false);
  });

  it("marks it as an update for this office", () => {
    const result = observe(OFFICE)(update());

    expect(Result.isSuccess(result) && result.success).toMatchObject({ source: "update", officeChannelId: OFFICE });
  });
});
