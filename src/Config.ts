import { Array, Config, Option, Redacted, Schema } from "effect";

const secret = (name: string) =>
  Config.schema(Schema.Redacted(Schema.NonEmptyString), name);

export const DiscordConfig = Config.all({
  botToken: secret("DISCORD_BOT_TOKEN"),
  officeChannelId: Config.NonEmptyString("DISCORD_OFFICE_CHANNEL_ID"),
});

export const SlackConfig = Config.all({
  webhookUrl: secret("SLACK_WEBHOOK_URL"),
});

// The first is preferred. The rest are the best of OpenRouter's free models in
// October 2026.
export const DEFAULT_MODELS: Array.NonEmptyReadonlyArray<string> = [
  "openrouter/free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "dots-studio/dots-3-note-preview:free",
];

// Blank counts as unset, since that's how CI passes a missing secret.
export const AiConfig = Config.all({
  apiKey: Config.Redacted("OPENROUTER_API_KEY").pipe(
    Config.option,
    Config.map(Option.filter((key) => Redacted.value(key).trim() !== "")),
  ),
  models: Config.Array(Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString)), "OPENROUTER_MODELS").pipe(
    Config.map((models) => (Array.isReadonlyArrayNonEmpty(models) ? models : DEFAULT_MODELS)),
    Config.withDefault(DEFAULT_MODELS),
  ),
});
