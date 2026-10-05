import { NodeHttpClient, NodeRuntime } from "@effect/platform-node";
import { Config, Console, Effect, Option } from "effect";

import { DEFAULT_OPENROUTER_BANTER_MODELS } from "../src/Config.ts";
import { briefFor, HeadlineWriter, openRouterProvider } from "../src/HeadlineWriter.ts";
import { OfficeEvent } from "../src/OfficeEvent.ts";
import { AI_DISCLAIMER } from "../src/SlackMessage.ts";
import { banterScenarios } from "./banter-scenarios.ts";

const office = { guildId: "guild", channelId: "office" };

const TryBanterConfig = Config.all({
  apiKey: Config.Redacted("OPENROUTER_API_KEY"),
  model: Config.NonEmptyString("BANTER_MODEL").pipe(Config.withDefault(DEFAULT_OPENROUTER_BANTER_MODELS[0])),
  only: Config.option(Config.NonEmptyString("BANTER_SCENARIO")),
});

const callAi = process.argv.includes("--call-ai");

const program = Effect.gen(function* () {
  const { apiKey, model, only } = yield* TryBanterConfig;

  const scenarios = banterScenarios.filter((scenario) =>
    Option.match(only, { onNone: () => true, onSome: (name) => scenario.name === name }),
  );

  const events = scenarios.map(({ name, ...context }) => ({ name, event: OfficeEvent.Banter({ ...office, ...context }) }));

  if (!callAi) {
    const [first] = events;

    if (first !== undefined) yield* Console.log(`System prompt:\n${briefFor(first.event).prompt}\n`);

    yield* Effect.forEach(events, ({ name, event }) =>
      Console.log(`── ${name} (${event.period}) ──\n${briefFor(event).request}\n`),
    );

    return yield* Console.log(`Printed ${events.length} prompts. Pass --call-ai to send each to ${model}, once.`);
  }

  const provider = yield* openRouterProvider(apiKey, [model]);
  const writer = yield* HeadlineWriter.pipe(Effect.provide(HeadlineWriter.layerProviders([provider])));

  yield* Console.log(`Asking ${model} once for each of ${events.length} scenarios\n`);

  yield* Effect.forEach(events, ({ name, event }) =>
    writer.write(event).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Console.log(`── ${name} (${event.period}) ──\nNo usable reply\n`),
          onSome: ({ template, button, model }) =>
            Console.log(`── ${name} (${event.period}) ──\n${template}\n[ ${button} ]  ✨ Banter by ${model} · ${AI_DISCLAIMER}\n`),
        }),
      ),
    ),
  );
});

program.pipe(Effect.scoped, Effect.provide(NodeHttpClient.layerUndici), NodeRuntime.runMain);
