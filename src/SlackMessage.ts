import { OfficeEvent, type OfficeMember } from "./OfficeEvent.ts";

// Slack treats &, < and > as control characters in message text. Escaping them
// stops a nickname like `<!channel>` from pinging everyone.
export const escapeSlackText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const joinLink = (member: OfficeMember): string =>
  `https://discord.com/channels/${member.guildId}/${member.channelId}`;

export const formatMessage = OfficeEvent.$match({
  Joined: (member) =>
    `🎙️ *${escapeSlackText(member.displayName)}* joined the virtual office — <${joinLink(member)}|join them>`,
  Left: (member) => `👋 *${escapeSlackText(member.displayName)}* left the virtual office`,
});
