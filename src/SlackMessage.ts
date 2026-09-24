import type { VoiceJoin } from "./VoiceJoin.ts";

// Slack treats &, < and > as control characters in message text. Escaping them
// stops a nickname like `<!channel>` from pinging everyone.
export const escapeSlackText = (text: string): string =>
  text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

export const joinLink = (join: VoiceJoin): string =>
  `https://discord.com/channels/${join.guildId}/${join.channelId}`;

export const formatMessage = (join: VoiceJoin): string =>
  `🎙️ *${escapeSlackText(join.displayName)}* joined the virtual office — <${joinLink(join)}|join them>`;
