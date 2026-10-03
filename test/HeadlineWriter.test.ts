import { assert, describe, it } from "@effect/vitest";
import { Array, Effect, Fiber, Layer, Option, Random, Ref, Schema, Stream } from "effect";
import { AiError, LanguageModel, Model, type Response } from "effect/ai";
import { TestClock } from "effect/testing";

import { HeadlineWriter, OpenedReply, UnnamedReply } from "../src/HeadlineWriter.ts";
import { OfficeEvent } from "../src/OfficeEvent.ts";
import { captureReports, opened } from "./fakes.ts";

type Reply = Effect.Effect<Array<Response.PartEncoded>, AiError.AiError>;

const says = (text: string): Reply => Effect.succeed([{ type: "text", text }]);

// Records its name in `calls` each time it's asked.
const fakeModel = (name: string, reply: Reply, calls: Ref.Ref<ReadonlyArray<string>>) =>
  Model.make(
    "test",
    name,
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: () => Ref.update(calls, (sent) => [...sent, name]).pipe(Effect.andThen(reply)),
        streamText: () => Stream.empty,
      }),
    ),
  );

// Tries the models in the order given.
const inOrder = Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 0.99 });

// Each provider is a list of named models and their replies.
const makeProviders = Effect.fnUntraced(function* (
  providers: Array.NonEmptyReadonlyArray<Array.NonEmptyReadonlyArray<readonly [string, Reply]>>,
) {
  const calls = yield* Ref.make<ReadonlyArray<string>>([]);

  const writer = yield* Effect.service(HeadlineWriter).pipe(
    Effect.provide(
      HeadlineWriter.layerProviders(
        Array.map(providers, (models) => Array.map(models, ([name, reply]) => fakeModel(name, reply, calls))),
      ),
    ),
  );

  return { writer, write: (event: OfficeEvent) => writer.write(event).pipe(inOrder), calls: Ref.get(calls) };
});

// One provider whose models are named model-1, model-2 and so on.
const makeWriter = (first: Reply, ...rest: ReadonlyArray<Reply>) =>
  makeProviders([Array.map(Array.prepend(rest, first), (reply, index) => [`model-${index + 1}`, reply] as const)]);

const modelDown: Reply = Effect.fail(
  AiError.make({
    module: "Test",
    method: "generateText",
    reason: new AiError.RateLimitError({}),
  }),
);

const dailyLimitHit: Reply = Effect.fail(
  AiError.make({
    module: "Test",
    method: "generateText",
    reason: new AiError.RateLimitError({
      http: {
        request: { method: "POST", url: "https://openrouter.ai/api/v1/chat/completions", urlParams: [], headers: {} },
        body: JSON.stringify({
          error: {
            code: 429,
            message: "Rate limit exceeded: free-models-per-day",
            metadata: { limit_source: "openrouter_free_tier_daily" },
          },
        }),
      },
    }),
  }),
);

const good = says("🛋️ {name} saved you a seat in the virtual office!\n🪑 Grab a seat");

describe("OpenedReply", () => {
  const decode = Schema.decodeOption(OpenedReply);

  it("reads the headline and the button label, ignoring whitespace, quotes and blank lines", () => {
    assert.deepStrictEqual(
      decode('  "🛋️ {name} saved you a seat!"\n\n🪑 Grab a seat\n'),
      Option.some(["🛋️ {name} saved you a seat!", "🪑 Grab a seat"] as const),
    );
  });

  it("rejects a reply without a button label, or with extra lines", () => {
    assert.isTrue(Option.isNone(decode("🛋️ {name} saved you a seat!")));
    assert.isTrue(Option.isNone(decode("🛋️ {name} saved you a seat!\n🪑 Grab a seat\nHope you like it!")));
  });

  it("rejects a headline without the placeholder, or with it twice", () => {
    assert.isTrue(Option.isNone(decode("🎉 Someone opened the office, come along!\n🪑 Grab a seat")));
    assert.isTrue(Option.isNone(decode("🎉 {name} opened the office. Say hi to {name}!\n🪑 Grab a seat")));
  });

  it("rejects Slack link syntax and overlong lines", () => {
    assert.isTrue(Option.isNone(decode("🎉 {name} opened the office <!channel>\n🪑 Grab a seat")));
    assert.isTrue(Option.isNone(decode(`🎉 {name} ${"very ".repeat(40)}open\n🪑 Grab a seat`)));
    assert.isTrue(Option.isNone(decode("🎉 {name} opened the office\n🪑 Grab a seat in the virtual office right now")));
  });
});

describe("UnnamedReply", () => {
  const decode = Schema.decodeOption(UnnamedReply);

  it("accepts a headline that names no one", () => {
    assert.deepStrictEqual(
      decode("🌙 The virtual office is quiet. Come back!\n🔦 Light it up"),
      Option.some(["🌙 The virtual office is quiet. Come back!", "🔦 Light it up"] as const),
    );
  });

  it("rejects the placeholder and Slack link syntax", () => {
    assert.isTrue(Option.isNone(decode("🌙 {name} left the virtual office.\n🔦 Light it up")));
    assert.isTrue(Option.isNone(decode("🌙 The office is quiet <!channel>\n🔦 Light it up")));
  });
});

const emptied = OfficeEvent.Emptied({ ...opened, recap: Option.none() });

const reminder = OfficeEvent.Reminder({ guildId: "g1", channelId: "c1", at: opened.at });

describe("HeadlineWriter", () => {
  it.effect("writes headlines for an emptied office and the reminder", () =>
    Effect.gen(function* () {
      const { write } = yield* makeWriter(says("🌙 The virtual office is quiet. Come back!\n🔦 Light it up"));

      assert.deepStrictEqual(
        yield* write(emptied),
        Option.some({ template: "🌙 The virtual office is quiet. Come back!", button: "🔦 Light it up", model: "model-1" }),
      );
      assert.isTrue(Option.isSome(yield* write(reminder)));
    }));

  it.effect("only lets an opened office's headline name someone", () =>
    Effect.gen(function* () {
      const { write } = yield* makeWriter(says("🌙 {name} left the virtual office. Come back!\n🔦 Light it up"));

      assert.isTrue(Option.isSome(yield* write(opened)));
      assert.isTrue(Option.isNone(yield* write(emptied)));
      assert.isTrue(Option.isNone(yield* write(reminder)));
    }));

  it.effect("returns the first model's headline without asking the others", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeWriter(good, good);

      assert.deepStrictEqual(
        yield* write(opened),
        Option.some({ template: "🛋️ {name} saved you a seat in the virtual office!", button: "🪑 Grab a seat", model: "model-1" }),
      );
      assert.deepStrictEqual(yield* calls, ["model-1"]);
    }));

  it.effect("credits the model a router picked, not the router", () =>
    Effect.gen(function* () {
      const { write } = yield* makeWriter(
        Effect.succeed([
          { type: "response-metadata", modelId: "vendor/picked-model:free" },
          { type: "text", text: "🎉 {name} is in!\n🎉 Join the party" },
        ]),
      );

      assert.deepStrictEqual(
        Option.map(yield* write(opened), ({ model }) => model),
        Option.some("vendor/picked-model:free"),
      );
    }));

  it.effect("moves on to the next model when one fails", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeWriter(modelDown, modelDown, good);

      assert.isTrue(Option.isSome(yield* write(opened)));
      assert.deepStrictEqual(yield* calls, ["model-1", "model-2", "model-3"]);
    }));

  it.effect("stops trying models once the daily free limit is hit", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeWriter(dailyLimitHit, good, good);

      assert.isTrue(Option.isNone(yield* write(opened)));
      assert.deepStrictEqual(yield* calls, ["model-1"]);
    }));

  it.effect("stops at the daily limit even after other failures", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeWriter(modelDown, dailyLimitHit, good);

      assert.isTrue(Option.isNone(yield* write(opened)));
      assert.deepStrictEqual(yield* calls, ["model-1", "model-2"]);
    }));

  it.effect("moves on to the next model when a headline is unusable", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeWriter(
        says("Sure! Here is a headline: Ada opened the office."),
        good,
      );

      assert.isTrue(Option.isSome(yield* write(opened)));
      assert.deepStrictEqual(yield* calls, ["model-1", "model-2"]);
    }));

  it.effect("moves on to the next model after a minute", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeWriter(Effect.never, good);

      const fiber = yield* write(opened).pipe(Effect.forkChild);

      yield* TestClock.adjust("59 seconds");
      assert.deepStrictEqual(yield* calls, ["model-1"]);

      yield* TestClock.adjust("1 second");

      assert.isTrue(Option.isSome(yield* Fiber.join(fiber)));
      assert.deepStrictEqual(yield* calls, ["model-1", "model-2"]);
    }));

  it.effect("tries every model once, preferring the first", () =>
    Effect.gen(function* () {
      const { writer, calls } = yield* makeWriter(modelDown, modelDown, modelDown, modelDown, modelDown);
      const runs = 200;

      yield* Effect.replicateEffect(writer.write(opened), runs, { discard: true }).pipe(Random.withSeed("order"));

      const perRun = Array.chunksOf(yield* calls, 5);
      const firsts = perRun.map(Array.headNonEmpty);

      assert.strictEqual(perRun.length, runs);
      assert.isTrue(perRun.every((tried) => new Set(tried).size === 5));
      assert.isAbove(firsts.filter((model) => model === "model-1").length, runs / 2);
      assert.includeMembers(firsts, ["model-2", "model-3", "model-4", "model-5"]);
    }));

  it.effect("falls back to the next provider once the first one's models fail", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeProviders([
        [
          ["openrouter-1", modelDown],
          ["openrouter-2", modelDown],
        ],
        [["cloudflare-1", good]],
      ]);

      assert.deepStrictEqual(
        Option.map(yield* write(opened), ({ model }) => model),
        Option.some("cloudflare-1"),
      );
      assert.deepStrictEqual(yield* calls, ["openrouter-1", "openrouter-2", "cloudflare-1"]);
    }));

  it.effect("may try the providers in either order", () =>
    Effect.gen(function* () {
      const { writer, calls } = yield* makeProviders([[["openrouter-1", good]], [["cloudflare-1", good]]]);

      yield* writer.write(opened).pipe(inOrder);
      yield* writer.write(opened).pipe(Effect.provideService(Random.Random, { nextIntUnsafe: () => 0, nextDoubleUnsafe: () => 0 }));

      assert.deepStrictEqual(yield* calls, ["openrouter-1", "cloudflare-1"]);
    }));

  it.effect("skips only the rest of a provider's models at its daily limit", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeProviders([
        [
          ["openrouter-1", dailyLimitHit],
          ["openrouter-2", good],
        ],
        [["cloudflare-1", good]],
      ]);

      assert.deepStrictEqual(
        Option.map(yield* write(opened), ({ model }) => model),
        Option.some("cloudflare-1"),
      );
      assert.deepStrictEqual(yield* calls, ["openrouter-1", "cloudflare-1"]);
    }));

  it.effect("falls back to the fixed headlines when every model fails", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeWriter(modelDown, modelDown);

      assert.isTrue(Option.isNone(yield* write(opened)));
      assert.deepStrictEqual(yield* calls, ["model-1", "model-2"]);
    }));

  it.effect("reports a warning when every model fails, but not when one succeeds", () =>
    Effect.gen(function* () {
      const { reports, layer } = captureReports();

      const failing = yield* makeWriter(modelDown, dailyLimitHit);
      yield* failing.write(opened).pipe(Effect.provide(layer));

      const working = yield* makeWriter(modelDown, good);
      yield* working.write(opened).pipe(Effect.provide(layer));

      assert.deepStrictEqual(reports, [
        {
          name: "NoAiHeadline",
          message: "No AI model could write a headline, the last failed with DailyLimit",
          severity: "Warn",
        },
      ]);
    }));

  it.effect("starts from the first model again on the next headline", () =>
    Effect.gen(function* () {
      const { write, calls } = yield* makeWriter(modelDown, good);

      yield* write(opened);
      yield* write(opened);

      assert.deepStrictEqual(yield* calls, ["model-1", "model-2", "model-1", "model-2"]);
    }));
});
