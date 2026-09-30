import { DateTime, Duration, Option } from "effect";
import { describe, expect, it } from "vitest";

import { OfficeEvent } from "../src/OfficeEvent.ts";
import { escapeSlackText, formatDuration, formatMessage, reminderHeadlines, weekdaysSinceEpoch } from "../src/SlackMessage.ts";

// 2026-09-25T14:05:00Z
const at = DateTime.makeUnsafe(1_790_345_100_000);

const member = {
  userId: "u1",
  displayName: "Ada",
  avatarUrl: "https://cdn.discordapp.com/avatars/u1/a.png",
  guildId: "g1",
  channelId: "c1",
  at,
};

const office = { guildId: "g1", channelId: "c1" };

// 2026-09-28T09:15:00Z, when the reminder fires on a Monday.
const monday = DateTime.makeUnsafe("2026-09-28T09:15:00Z");

const reminder = { ...office, at: monday };

const JOIN_URL = "https://discord.com/channels/g1/c1";

const TIME = "<!date^1790345100^{time}|14:05 UTC>";

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

describe("formatDuration", () => {
  it("rounds anything short down to under a minute", () => {
    expect(formatDuration(Duration.seconds(59))).toBe("under a minute");
  });

  it("shows minutes, hours, or both", () => {
    expect(formatDuration(Duration.minutes(14))).toBe("14m");
    expect(formatDuration(Duration.hours(2))).toBe("2h");
    expect(formatDuration(Duration.minutes(134))).toBe("2h 14m");
  });

  it("counts past a day in hours", () => {
    expect(formatDuration(Duration.hours(26))).toBe("26h");
  });
});

describe("formatMessage", () => {
  it("shows who opened the office with their avatar, a join button and the time", () => {
    expect(formatMessage(OfficeEvent.Opened(member), 0)).toEqual({
      text: "🎙️ *Ada* opened the virtual office — everyone's welcome to join!",
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: "🎙️ *Ada* opened the virtual office — everyone's welcome to join!" },
          accessory: { type: "image", image_url: member.avatarUrl, alt_text: "Ada" },
        },
        {
          type: "actions",
          elements: [
            {
              type: "button",
              text: { type: "plain_text", text: "🎧 Join the office", emoji: true },
              url: JOIN_URL,
              style: "primary",
            },
          ],
        },
        { type: "context", elements: [{ type: "mrkdwn", text: `🔊 Opened on Discord at ${TIME}` }] },
      ],
    });
  });

  it("leaves the avatar out when Discord didn't send one", () => {
    const [headline] = formatMessage(OfficeEvent.Opened({ ...member, avatarUrl: null }), 0).blocks;

    expect(headline).not.toHaveProperty("accessory");
  });

  it("recaps the session when the office empties", () => {
    const message = formatMessage(
      OfficeEvent.Emptied({
        ...member,
        recap: Option.some({ duration: Duration.minutes(134), visitors: 5 }),
      }),
      0,
    );

    expect(message.text).toBe("🪑 The virtual office is empty right now — jump in and get it going!");
    expect(message.blocks).toContainEqual({
      type: "section",
      fields: [
        { type: "mrkdwn", text: "*Open for*\n2h 14m" },
        { type: "mrkdwn", text: "*Stopped by*\n5 people" },
      ],
    });
    expect(message.blocks.at(-1)).toEqual({
      type: "context",
      elements: [{ type: "mrkdwn", text: `🔇 Emptied at ${TIME}` }],
    });
  });

  it("says person, not people, for a solo session", () => {
    const message = formatMessage(
      OfficeEvent.Emptied({ ...member, recap: Option.some({ duration: Duration.minutes(5), visitors: 1 }) }),
      0,
    );

    expect(JSON.stringify(message.blocks)).toContain("1 person");
  });

  it("skips the recap when the session started before the bot did", () => {
    const message = formatMessage(OfficeEvent.Emptied({ ...member, recap: Option.none() }), 0);

    expect(JSON.stringify(message.blocks)).not.toContain("Open for");
  });

  it("links the reminder to the office", () => {
    const message = formatMessage(OfficeEvent.Reminder(reminder), 0);

    expect(JSON.stringify(message.blocks)).toContain(JOIN_URL);
  });

  it("rotates the reminder by date and ignores the variant", () => {
    const onDay = (day: number, variant = 0) =>
      formatMessage(OfficeEvent.Reminder({ ...office, at: DateTime.add(monday, { days: day }) }), variant).text;

    expect(onDay(0, 0)).toBe(onDay(0, 7));
    expect(onDay(0)).not.toBe(onDay(1));
  });

  it("shows every reminder once before repeating, skipping weekends", () => {
    const count = reminderHeadlines.length;

    // Weekdays only, the way the reminder cron fires.
    const weekdays = Array.from({ length: count + 1 }, (_, n) => Math.floor(n / 5) * 7 + (n % 5));

    const texts = weekdays.map(
      (day) => formatMessage(OfficeEvent.Reminder({ ...office, at: DateTime.add(monday, { days: day }) }), 0).text,
    );

    expect(new Set(texts).size).toBe(count);
    expect(texts[count]).toBe(texts[0]);
  });

  it("copes with a negative variant", () => {
    expect(formatMessage(OfficeEvent.Opened(member), -1).text).toBeTypeOf("string");
  });

  it("escapes the display name in every phrasing", () => {
    for (const variant of [0, 1, 2]) {
      const message = formatMessage(OfficeEvent.Opened({ ...member, displayName: "<!here>" }), variant);

      expect(message.text).toContain("*&lt;!here&gt;*");
      expect(message.blocks[0]).toMatchObject({ text: { text: message.text } });
    }
  });
});

describe("weekdaysSinceEpoch", () => {
  it("counts consecutive weekdays and pauses over the weekend", () => {
    const count = (iso: string) => weekdaysSinceEpoch(DateTime.makeUnsafe(iso));

    // The epoch was a Thursday.
    expect(count("1970-01-01T09:15:00Z")).toBe(3);
    expect(count("1970-01-02T09:15:00Z")).toBe(4);
    expect(count("1970-01-03T09:15:00Z")).toBe(5);
    expect(count("1970-01-04T09:15:00Z")).toBe(5);
    expect(count("1970-01-05T09:15:00Z")).toBe(5);
    expect(count("1970-01-06T09:15:00Z")).toBe(6);
  });
});
