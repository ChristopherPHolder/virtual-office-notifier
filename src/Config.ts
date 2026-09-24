import { Config, Schema } from "effect";

const secret = (name: string) =>
  Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

export const DiscordConfig = Config.all({
  botToken: secret("DISCORD_BOT_TOKEN"),
  officeChannelId: Config.NonEmptyString("DISCORD_OFFICE_CHANNEL_ID"),
});

export const SlackConfig = Config.all({
  webhookUrl: secret("SLACK_WEBHOOK_URL"),
});
