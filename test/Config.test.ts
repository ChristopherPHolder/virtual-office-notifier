import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option, Redacted } from "effect";

import {
  AiConfig,
  DEFAULT_CLOUDFLARE_MODELS,
  DEFAULT_OPENROUTER_MODELS,
  DiscordConfig,
  SlackConfig,
} from "../src/Config.ts";
import { withEnv } from "./fakes.ts";

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

  it.effect("treats missing or blank AI credentials as unset, with free default models", () =>
    Effect.gen(function* () {
      const missing = yield* AiConfig.pipe(withEnv({}));

      const blank = yield* AiConfig.pipe(
        withEnv({ OPENROUTER_API_KEY: " ", CLOUDFLARE_ACCOUNT_ID: "", CLOUDFLARE_API_TOKEN: " " }),
      );

      for (const { openRouter, cloudflare } of [missing, blank]) {
        assert.isTrue(Option.isNone(openRouter.apiKey));
        assert.isTrue(Option.isNone(cloudflare.accountId));
        assert.isTrue(Option.isNone(cloudflare.apiToken));
      }

      assert.deepStrictEqual(missing.openRouter.models, DEFAULT_OPENROUTER_MODELS);
      assert.deepStrictEqual(missing.cloudflare.models, DEFAULT_CLOUDFLARE_MODELS);
    }));

  it.effect("loads the AI credentials redacted and the models in order", () =>
    Effect.gen(function* () {
      const { openRouter, cloudflare } = yield* AiConfig.pipe(
        withEnv({
          OPENROUTER_API_KEY: "sk-or-secret",
          OPENROUTER_MODELS: "a/one:free, openrouter/free",
          CLOUDFLARE_ACCOUNT_ID: "account",
          CLOUDFLARE_API_TOKEN: "cf-secret",
          CLOUDFLARE_MODELS: "@cf/a/one",
        }),
      );

      assert.deepStrictEqual(Option.map(openRouter.apiKey, Redacted.value), Option.some("sk-or-secret"));
      assert.deepStrictEqual(openRouter.models, ["a/one:free", "openrouter/free"]);
      assert.deepStrictEqual(Option.map(cloudflare.accountId, Redacted.value), Option.some("account"));
      assert.deepStrictEqual(Option.map(cloudflare.apiToken, Redacted.value), Option.some("cf-secret"));
      assert.deepStrictEqual(cloudflare.models, ["@cf/a/one"]);
    }));

  it.effect("rejects a blank entry in the model list", () =>
    Effect.gen(function* () {
      const exit = yield* AiConfig.pipe(withEnv({ OPENROUTER_MODELS: "a/one:free,," }), Effect.exit);

      assert.include(failureMessage(exit), "OPENROUTER_MODELS");
    }));
});
