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

// Blank counts as unset, since that's how CI passes a missing secret.
const optionalSecret = (name: string) =>
  Config.Redacted(name).pipe(
    Config.option,
    Config.map(Option.filter((value) => Redacted.value(value).trim() !== "")),
  );

const modelList = (name: string, defaults: Array.NonEmptyReadonlyArray<string>) =>
  Config.Array(Schema.Trim.pipe(Schema.decodeTo(Schema.NonEmptyString)), name).pipe(
    Config.map((models) => (Array.isReadonlyArrayNonEmpty(models) ? models : defaults)),
    Config.withDefault(defaults),
  );

// The first is preferred. The rest are the best of OpenRouter's free models in
// October 2026.
export const DEFAULT_OPENROUTER_MODELS: Array.NonEmptyReadonlyArray<string> = [
  "openrouter/free",
  "nvidia/nemotron-3-ultra-550b-a55b:free",
  "nvidia/nemotron-3-super-120b-a12b:free",
  "inclusionai/ling-3.0-flash-sante:free",
  "dots-studio/dots-3-note-preview:free",
];

// All within Workers AI's free daily allocation.
export const DEFAULT_CLOUDFLARE_MODELS: Array.NonEmptyReadonlyArray<string> = [
  "@cf/nvidia/nemotron-3-120b-a12b",
  "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
  "@cf/google/gemma-4-26b-a4b-it",
];

// With no DSN, nothing is sent to Sentry and logs only go to the console.
export const SentryConfig = Config.all({
  dsn: optionalSecret("SENTRY_DSN"),
  environment: Config.NonEmptyString("SENTRY_ENVIRONMENT").pipe(Config.withDefault("development")),
  release: Config.option(Config.NonEmptyString("SENTRY_RELEASE")),
});

export const AiConfig = Config.all({
  openRouter: Config.all({
    apiKey: optionalSecret("OPENROUTER_API_KEY"),
    models: modelList("OPENROUTER_MODELS", DEFAULT_OPENROUTER_MODELS),
  }),
  cloudflare: Config.all({
    accountId: optionalSecret("CLOUDFLARE_ACCOUNT_ID"),
    apiToken: optionalSecret("CLOUDFLARE_API_TOKEN"),
    models: modelList("CLOUDFLARE_MODELS", DEFAULT_CLOUDFLARE_MODELS),
  }),
});

// Optional, so local runs don't write to the production database unless asked
// to. Without it, nothing is recorded.
export const DatabaseConfig = Config.all({
  url: optionalSecret("DATABASE_URL"),
});

// Production always records, so a deploy without it fails instead of quietly
// recording nothing.
export const ProductionDatabaseConfig = Config.all({
  url: secret("DATABASE_URL"),
});
