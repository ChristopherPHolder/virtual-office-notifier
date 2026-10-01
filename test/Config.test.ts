import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Exit, Option, Redacted } from "effect";

import { AiConfig, DEFAULT_MODELS, DiscordConfig, SlackConfig } from "../src/Config.ts";

const withEnv = (env: Record<string, string>) =>
  Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }));

const failureMessage = <A, E>(exit: Exit.Exit<A, E>): string =>
  Exit.isFailure(exit) ? String(exit.cause) : "";

describe("Config", () => {
  it.effect("loads the Discord settings with the token redacted", () =>
    Effect.gen(function* () {
      const config = yield* DiscordConfig.pipe(
        withEnv({ DISCORD_BOT_TOKEN: "secret-token", DISCORD_OFFICE_CHANNEL_ID: "123" }),
      );

      assert.strictEqual(config.officeChannelId, "123");
      assert.strictEqual(Redacted.value(config.botToken), "secret-token");
      assert.notInclude(String(config.botToken), "secret-token");
    }));

  it.effect("names a missing variable", () =>
    Effect.gen(function* () {
      const exit = yield* DiscordConfig.pipe(
        withEnv({ DISCORD_BOT_TOKEN: "secret-token" }),
        Effect.exit,
      );

      assert.include(failureMessage(exit), "DISCORD_OFFICE_CHANNEL_ID");
    }));

  it.effect("rejects an empty secret without leaking anything", () =>
    Effect.gen(function* () {
      const exit = yield* SlackConfig.pipe(withEnv({ SLACK_WEBHOOK_URL: "" }), Effect.exit);

      assert.isTrue(Exit.isFailure(exit));
      assert.include(failureMessage(exit), "SLACK_WEBHOOK_URL");
    }));

  it.effect("treats a missing or blank OpenRouter key as no key, with free default models", () =>
    Effect.gen(function* () {
      const missing = yield* AiConfig.pipe(withEnv({}));
      const blank = yield* AiConfig.pipe(withEnv({ OPENROUTER_API_KEY: " " }));

      assert.isTrue(Option.isNone(missing.apiKey));
      assert.isTrue(Option.isNone(blank.apiKey));
      assert.deepStrictEqual(missing.models, DEFAULT_MODELS);
    }));

  it.effect("loads the OpenRouter key redacted and the models in order", () =>
    Effect.gen(function* () {
      const config = yield* AiConfig.pipe(withEnv({ OPENROUTER_API_KEY: "sk-or-secret", OPENROUTER_MODELS: "a/one:free, openrouter/free" }));

      assert.deepStrictEqual(Option.map(config.apiKey, Redacted.value), Option.some("sk-or-secret"));
      assert.deepStrictEqual(config.models, ["a/one:free", "openrouter/free"]);
    }));

  it.effect("rejects a blank entry in the model list", () =>
    Effect.gen(function* () {
      const exit = yield* AiConfig.pipe(withEnv({ OPENROUTER_MODELS: "a/one:free,," }), Effect.exit);

      assert.include(failureMessage(exit), "OPENROUTER_MODELS");
    }));
});
