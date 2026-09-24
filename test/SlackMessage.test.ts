import { describe, expect, it } from "vitest";

import { escapeSlackText, formatMessage } from "../src/SlackMessage.ts";

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
  it("names the member and links to the channel", () => {
    expect(
      formatMessage({ userId: "u1", displayName: "Ada", guildId: "g1", channelId: "c1" }),
    ).toBe(
      "🎙️ *Ada* joined the virtual office — <https://discord.com/channels/g1/c1|join them>",
    );
  });

  it("escapes the display name", () => {
    expect(
      formatMessage({ userId: "u1", displayName: "<!here>", guildId: "g1", channelId: "c1" }),
    ).toContain("*&lt;!here&gt;*");
  });
});
