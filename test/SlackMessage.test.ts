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
  it("names the member who joined and links to the channel", () => {
    expect(formatMessage(OfficeEvent.Joined(member))).toBe(
      "🎙️ *Ada* joined the virtual office — <https://discord.com/channels/g1/c1|join them>",
    );
  });

  it("names the member who left", () => {
    expect(formatMessage(OfficeEvent.Left(member))).toBe("👋 *Ada* left the virtual office");
  });

  it("escapes the display name", () => {
    expect(formatMessage(OfficeEvent.Joined({ ...member, displayName: "<!here>" }))).toContain(
      "*&lt;!here&gt;*",
    );
    expect(formatMessage(OfficeEvent.Left({ ...member, displayName: "<!here>" }))).toContain(
      "*&lt;!here&gt;*",
    );
  });
});
