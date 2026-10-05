import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai-compat";
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { NodeHttpClient } from "@effect/platform-node";
import {
  Array,
  Cause,
  Context,
  Effect,
  ErrorReporter,
  ExecutionPlan,
  identity,
  Layer,
  type LogLevel,
  Match,
  Option,
  Random,
  Redacted,
  Schema,
  SchemaTransformation,
} from "effect";
import { AiError, LanguageModel, Model, type Response } from "effect/ai";
import type { HttpClient } from "effect/http";

import { banterLog } from "./Banter.ts";
import { AiConfig } from "./Config.ts";
import { OfficeEvent } from "./OfficeEvent.ts";
import {
  banterExamples,
  emptiedHeadlines,
  type GeneratedHeadline,
  JOIN_LABEL,
  JUMP_IN_LABEL,
  NAME_PLACEHOLDER,
  openedHeadlines,
  reminderHeadlines,
  type Variants,
} from "./SlackMessage.ts";

// One line with no Slack link or mention syntax. Models like to wrap a line in
// quotes.
const Line = (minLength: number, maxLength: number, pattern: RegExp) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.String.check(Schema.isMinLength(minLength), Schema.isMaxLength(maxLength), Schema.isPattern(pattern)),
      SchemaTransformation.transform({
        decode: (line) => line.trim().replace(/^["'“]+|["'”]+$/g, "").trim(),
        encode: identity,
      }),
    ),
  );

// The headline on the first line and the button label on the second.
const ReplyWith = (headline: ReturnType<typeof Line>) =>
  Schema.String.pipe(
    Schema.decodeTo(
      Schema.Array(Schema.String),
      SchemaTransformation.transform({
        decode: (text): ReadonlyArray<string> => text.split("\n").filter((line) => line.trim() !== ""),
        encode: (lines) => lines.join("\n"),
      }),
    ),
    Schema.decodeTo(Schema.Tuple([headline, Line(3, 30, /^[^{}<>]+$/)]), SchemaTransformation.passthroughSupertype()),
  );

export const OpenedReply = ReplyWith(Line(10, 160, /^[^{}<>]*\{name\}[^{}<>]*$/));

export const UnnamedReply = ReplyWith(Line(10, 160, /^[^{}<>]+$/));

export const BanterReply = ReplyWith(Line(10, 300, /^[^{}<>]+$/));

export class UnusableHeadline extends Schema.TaggedError<UnusableHeadline>()("UnusableHeadline", {
  text: Schema.String,
}) {}

// Reported once every model has failed, so a run of fixed headlines shows up
// in Sentry. `reason` is why the last model failed.
export class NoAiHeadline extends Schema.TaggedError<NoAiHeadline>()("NoAiHeadline", {
  reason: Schema.String,
}) {
  override get message(): string {
    return `No AI model could write a headline, the last failed with ${this.reason}`;
  }

  override get [ErrorReporter.severity](): LogLevel.Severity {
    return "Warn";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason };
  }
}

interface Brief {
  readonly prompt: string;
  readonly request: string;
  readonly reply: typeof OpenedReply;
}

const announcement = (task: string, examples: Variants, button: string, reply: typeof OpenedReply): Brief => ({
  prompt: [
    "You write one-line Slack announcements for a team's virtual office, a Discord voice channel where people work alongside each other.",
    task,
    "Reply with exactly two lines and nothing else: no quotes, no labels, no explanation, no markdown.",
    "Line 1 is the headline. Start it with a single fitting emoji and keep it under 120 characters.",
    `Line 2 is the label for the button that joins the office. Make it 2 to 4 words that play off the headline, start it with an emoji, and keep it under 30 characters. It used to always say "${button}".`,
    "Here are some past headlines. Match their tone, but write something new:",
    ...examples,
  ].join("\n"),
  request: "Write today's headline.",
  reply,
});

const BANTER_PROMPT = [
  "You write short, playful Slack messages for a team's virtual office, a Discord voice channel where people work alongside each other.",
  "You'll get a log of what happened in the office. Read all of it, pick the single most striking thing in it and write a message about it. It could be an early bird, a night owl, a marathon session, a mute and unmute frenzy, everyone turning their cameras on at once, a rare camera appearance, a crowd, a lone regular, two people who keep turning up together, or an office nobody visited.",
  "In the log, Joined and Left are arriving and leaving, AlreadyThere means they were in when the log started, Muted and Unmuted are their own microphone, Deafened means they turned their sound off, ServerMuted means a moderator muted them, CameraOn is their camera and StreamStarted is sharing their screen.",
  "Get the facts right: only say what the log shows, with the right people, days, times and counts. If the log is from last week, say last week.",
  "Name people when it makes the message better, exactly as they're written in the log. Refer to people by name or as they, never as he or she.",
  "Tease gently and keep it warm: never be mean, and never shame anyone for being away, leaving early or how much they work.",
  "Reply with exactly two lines and nothing else: no quotes, no labels, no explanation, no markdown.",
  "Line 1 is the message. Start it with a single fitting emoji and keep it to one or two sentences, under 250 characters.",
  "Line 2 is the label for the button that joins the office. Make it 2 to 4 words that play off the message, start it with an emoji, and keep it under 30 characters.",
  "Here are some example messages. Match their tone, but don't reuse their jokes:",
  ...banterExamples,
].join("\n");

export const briefFor = OfficeEvent.$match({
  Opened: (): Brief =>
    announcement(
      `Someone just opened the office. Write a short, warm, playful headline that says so and invites others to join. Refer to the person only as ${NAME_PLACEHOLDER}, exactly once.`,
      openedHeadlines(NAME_PLACEHOLDER),
      JOIN_LABEL,
      OpenedReply,
    ),
  Emptied: (): Brief =>
    announcement(
      "Everyone just left the office, so it's empty. Write a short, warm, playful headline that says so and invites people to jump back in. Don't name anyone.",
      emptiedHeadlines,
      JUMP_IN_LABEL,
      UnnamedReply,
    ),
  Reminder: (): Brief =>
    announcement(
      "It's the weekday reminder. Write a short, funny headline inviting the team to come work alongside each other in the office. Don't name anyone.",
      reminderHeadlines,
      JOIN_LABEL,
      UnnamedReply,
    ),
  Banter: (context): Brief => ({ prompt: BANTER_PROMPT, request: banterLog(context), reply: BanterReply }),
});

// Free models often take 5-10 seconds, and sometimes over 30.
const MODEL_TIMEOUT = "1 minute";

type HeadlineError = AiError.AiError | Cause.TimeoutError | UnusableHeadline;

const decodeDailyLimitBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      error: Schema.Struct({
        metadata: Schema.Struct({ limit_source: Schema.Literal("openrouter_free_tier_daily") }),
      }),
    }),
  ),
);

// The key's free requests for the day are used up, so every other free model
// would refuse too.
const isDailyLimit = (error: HeadlineError): boolean =>
  error instanceof AiError.AiError &&
  error.reason instanceof AiError.RateLimitError &&
  Option.isSome(decodeDailyLimitBody(error.reason.http?.body));

const failureReason = Match.typeTags<HeadlineError, string>()({
  AiError: (error) => (isDailyLimit(error) ? "DailyLimit" : error.reason._tag),
  TimeoutError: () => "Timeout",
  UnusableHeadline: () => "UnusableHeadline",
});

// A router like openrouter/free reports which model actually answered.
const respondingModel = (content: ReadonlyArray<Response.AnyPart>, requested: string): string =>
  Array.findFirst(content, (part): part is Response.ResponseMetadataPart => part.type === "response-metadata").pipe(
    Option.flatMap((part) => Option.fromUndefinedOr(part.modelId)),
    Option.getOrElse(() => requested),
  );

const logFailure = Effect.fnUntraced(function* (error: HeadlineError) {
  const model = yield* Model.ModelName;

  yield* Effect.logWarning("AI model couldn't write a headline").pipe(
    Effect.annotateLogs({ model, reason: failureReason(error) }),
  );
});

const writeWithModel = Effect.fnUntraced(function* (brief: Brief) {
  const model = yield* Model.ModelName;

  const response = yield* LanguageModel.generateText({
    prompt: [
      { role: "system", content: brief.prompt },
      { role: "user", content: brief.request },
    ],
  }).pipe(Effect.timeout(MODEL_TIMEOUT));

  const [template, button] = yield* Schema.decodeEffect(brief.reply)(response.text).pipe(
    Effect.mapError(() => new UnusableHeadline({ text: response.text })),
  );

  return { template, button, model: respondingModel(response.content, model) };
}, Effect.tapError(logFailure));

// The first model goes first at least half the time, and the rest follow in
// random order.
const orderModels = Effect.fnUntraced(function* <A>(models: Array.NonEmptyReadonlyArray<A>) {
  const first = (yield* Random.nextBoolean) ? models[0] : yield* Random.choice(models);

  return Array.prepend(yield* Random.shuffle(Array.filter(models, (model) => model !== first)), first);
});

type ModelLayer = Layer.Layer<LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName>;

interface ModelStep {
  readonly provide: ModelLayer;
  readonly while: (error: HeadlineError) => boolean;
}

// A daily limit only skips the rest of that provider's models.
const providerSteps = (models: Array.NonEmptyReadonlyArray<ModelLayer>) =>
  Array.map(models, (provide, index): ModelStep => ({ provide, while: (error) => index === 0 || !isDailyLimit(error) }));

// Thinking would spend the minute and the free daily Neurons before the reply,
// and a headline needs well under 200 tokens.
const CLOUDFLARE_MODEL_CONFIG = {
  temperature: 1,
  max_output_tokens: 200,
  chat_template_kwargs: { enable_thinking: false },
};

// Builds the provider's client once, for as long as the writer lives.
const withClient = Effect.fnUntraced(function* <C>(
  models: Array.NonEmptyReadonlyArray<Model.Model<"openai", LanguageModel.LanguageModel, C>>,
  client: Layer.Layer<C, never, HttpClient.HttpClient>,
) {
  const context = yield* Layer.build(client);

  return yield* Effect.all(Array.map(models, (model) => model.captureRequirements)).pipe(Effect.provideContext(context));
});

export const openRouterProvider = (apiKey: Redacted.Redacted<string>, models: Array.NonEmptyReadonlyArray<string>) =>
  withClient(
    Array.map(models, (model) => OpenRouterLanguageModel.model(model, { temperature: 1 })),
    OpenRouterClient.layer({ apiKey, siteTitle: "Virtual Office Notifier" }),
  );

export const cloudflareProvider = (
  accountId: Redacted.Redacted<string>,
  apiToken: Redacted.Redacted<string>,
  models: Array.NonEmptyReadonlyArray<string>,
) =>
  withClient(
    Array.map(models, (model) => OpenAiLanguageModel.model(model, CLOUDFLARE_MODEL_CONFIG)),
    OpenAiClient.layer({
      apiKey: apiToken,
      apiUrl: `https://api.cloudflare.com/client/v4/accounts/${Redacted.value(accountId)}/ai/v1`,
    }),
  );

type Providers = Array.NonEmptyReadonlyArray<Array.NonEmptyReadonlyArray<ModelLayer>>;

export class HeadlineWriter extends Context.Service<
  HeadlineWriter,
  {
    // None means the fixed phrasings should be used.
    write(event: OfficeEvent): Effect.Effect<Option.Option<GeneratedHeadline>>;
  }
>()("virtual-office-notifier/HeadlineWriter") {
  // Either provider may go first, and its models are tried in turn until one
  // writes a usable headline.
  static readonly layerProviders = (
    providers: Providers,
    banterProviders: Providers = providers,
  ) =>
    Layer.succeed(
      HeadlineWriter,
      HeadlineWriter.of({
        write: Effect.fn("HeadlineWriter.write")(
          function* (event: OfficeEvent) {
            const candidates = OfficeEvent.$is("Banter")(event) ? banterProviders : providers;
            const shuffled = (yield* Random.nextBoolean) ? candidates : Array.reverse(candidates);
            const ordered = yield* Effect.all(Array.map(shuffled, orderModels));
            const plan = ExecutionPlan.make<Array.NonEmptyReadonlyArray<ModelStep>>(...Array.flatMap(ordered, providerSteps));

            return yield* writeWithModel(briefFor(event)).pipe(Effect.withExecutionPlan(plan));
          },
          Effect.tapError((error) =>
            Effect.logWarning("No AI model could write a headline").pipe(
              Effect.andThen(ErrorReporter.report(Cause.fail(new NoAiHeadline({ reason: failureReason(error) })))),
            ),
          ),
          Effect.option,
          (effect, event) => Effect.annotateLogs(effect, { headline: event._tag }),
        ),
      }),
    );

  static readonly layerFixed = Layer.succeed(HeadlineWriter, HeadlineWriter.of({ write: () => Effect.succeedNone }));

  static readonly layer = Layer.unwrap(
    Effect.gen(function* () {
      const { openRouter, cloudflare } = yield* AiConfig;

      const cloudflareModels = Option.all({ accountId: cloudflare.accountId, apiToken: cloudflare.apiToken }).pipe(
        Option.map(({ accountId, apiToken }) => cloudflareProvider(accountId, apiToken, cloudflare.models)),
      );

      const providersWith = (openRouterModels: Array.NonEmptyReadonlyArray<string>) =>
        Effect.all([
          ...Option.toArray(Option.map(openRouter.apiKey, (apiKey) => openRouterProvider(apiKey, openRouterModels))),
          ...Option.toArray(cloudflareModels),
        ]);

      const providers = yield* providersWith(openRouter.models);
      const banterProviders = yield* providersWith(openRouter.banterModels);

      return Array.match(providers, {
        onEmpty: () =>
          Layer.effectDiscard(Effect.logInfo("No AI provider configured, so using the fixed headlines")).pipe(
            Layer.provideMerge(HeadlineWriter.layerFixed),
          ),
        onNonEmpty: (headlineProviders) =>
          HeadlineWriter.layerProviders(
            headlineProviders,
            Array.isReadonlyArrayNonEmpty(banterProviders) ? banterProviders : headlineProviders,
          ),
      });
    }),
  ).pipe(Layer.provide(NodeHttpClient.layerUndici));
}
