import { OfficeEvent, type OfficeLocation } from "./OfficeEvent.ts";

// Slack treats &, < and > as control characters in message text. Escaping them
// stops a nickname like `<!channel>` from pinging everyone.
export const escapeSlackText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const joinLink = (office: OfficeLocation): string =>
  `https://discord.com/channels/${office.guildId}/${office.channelId}`;

export const formatMessage = OfficeEvent.$match({
  Opened: (member) =>
    `🎙️ *${escapeSlackText(member.displayName)}* opened the virtual office — everyone's welcome to <${joinLink(member)}|join>!`,
  Emptied: (member) => `🪑 The virtual office is empty right now — <${joinLink(member)}|jump in> and get it going!`,
  Reminder: (office) => `⏰ Daily reminder: come hang out in the virtual office — <${joinLink(office)}|join> us!`,
});
