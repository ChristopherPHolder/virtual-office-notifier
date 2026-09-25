import { describe, expect, it } from "vitest";

import { OfficeEvent } from "../src/OfficeEvent.ts";
import { escapeSlackText, formatMessage } from "../src/SlackMessage.ts";

const member = { userId: "u1", displayName: "Ada", guildId: "g1", channelId: "c1" };

describe("escapeSlackText", () => {
  it("escapes Slack control characters", () => {
    expect(escapeSlackText("<!channel> & <@U123>")).toBe(
      "&lt;!channel&gt; &amp; &lt;@U123&gt;",
    );
  });

  it("does not double-escape an existing entity", () => {
    expect(escapeSlackText("&lt;")).toBe("&amp;lt;");
  });
});

describe("formatMessage", () => {
  it("names who opened the office and invites everyone to join", () => {
    expect(formatMessage(OfficeEvent.Opened(member))).toBe(
      "🎙️ *Ada* opened the virtual office — everyone's welcome to <https://discord.com/channels/g1/c1|join>!",
    );
  });

  it("invites people to join when the office empties", () => {
    expect(formatMessage(OfficeEvent.Emptied(member))).toBe(
      "🪑 The virtual office is empty right now — <https://discord.com/channels/g1/c1|jump in> and get it going!",
    );
  });

  it("links to the office in the daily reminder", () => {
    expect(formatMessage(OfficeEvent.Reminder({ guildId: "g1", channelId: "c1" }))).toBe(
      "⏰ Daily reminder: come hang out in the virtual office — <https://discord.com/channels/g1/c1|join> us!",
    );
  });

  it("escapes the display name", () => {
    expect(formatMessage(OfficeEvent.Opened({ ...member, displayName: "<!here>" }))).toContain(
      "*&lt;!here&gt;*",
    );
  });
});
