import { NodeHttpClient } from "@effect/platform-node";
import {
  Context,
  Duration,
  Effect,
  ErrorReporter,
  Layer,
  type LogLevel,
  Match,
  Option,
  Random,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import {
  Headers,
  HttpClient,
  HttpClientRequest,
  type HttpClientError,
  type HttpClientResponse,
} from "effect/http";

import { SlackConfig } from "./Config.ts";
import { HeadlineWriter } from "./HeadlineWriter.ts";
import { formatMessage, type SlackMessage } from "./SlackMessage.ts";
import type { OfficeEvent } from "./OfficeEvent.ts";

export class RateLimited extends Schema.TaggedError<RateLimited>()("RateLimited", {
  retryAfter: Schema.Duration,
}) {}

export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
  status: Schema.Int,
}) {}

// `cause` is a description rather than the HttpClientError itself, because that
// error's message includes the request URL, and the webhook URL is a secret.
export class Transport extends Schema.TaggedError<Transport>()("Transport", {
  cause: Schema.String,
}) {}

export class WebhookRevoked extends Schema.TaggedError<WebhookRevoked>()("WebhookRevoked", {
  status: Schema.Int,
  body: Schema.String,
}) {}

export class InvalidPayload extends Schema.TaggedError<InvalidPayload>()("InvalidPayload", {
  status: Schema.Int,
  body: Schema.String,
}) {}

export const SlackErrorReason = Schema.Union([
  RateLimited,
  Unavailable,
  Transport,
  WebhookRevoked,
  InvalidPayload,
]);

export type SlackErrorReason = typeof SlackErrorReason.Type;

export class SlackError extends Schema.TaggedError<SlackError>()("SlackError", {
  reason: SlackErrorReason,
}) {
  override get message(): string {
    return isRetryable(this.reason)
      ? `Gave up posting to Slack after retries: ${this.reason._tag}`
      : `Slack rejected the post: ${this.reason._tag}`;
  }

  // Slack being down usually sorts itself out; a revoked webhook or rejected
  // payload needs fixing.
  override get [ErrorReporter.severity](): LogLevel.Severity {
    return isRetryable(this.reason) ? "Warn" : "Error";
  }

  override get [ErrorReporter.attributes]() {
    return { reason: this.reason._tag };
  }
}

export const isRetryable = Match.typeTags<SlackErrorReason, boolean>()({
  RateLimited: () => true,
  Unavailable: () => true,
  Transport: () => true,
  WebhookRevoked: () => false,
  InvalidPayload: () => false,
});

const DEFAULT_RETRY_AFTER = Duration.seconds(1);

const decodeRetryAfterSeconds = Schema.decodeUnknownOption(
  Schema.FiniteFromString.check(Schema.isGreaterThanOrEqualTo(0)),
);

const retryAfter = (headers: Headers.Headers): Duration.Duration =>
  Headers.get(headers, "retry-after").pipe(
    Option.flatMap(decodeRetryAfterSeconds),
    Option.match({ onNone: () => DEFAULT_RETRY_AFTER, onSome: Duration.seconds }),
  );

const reasonForStatus = (
  response: HttpClientResponse.HttpClientResponse,
  body: string,
): SlackErrorReason => {
  const status = response.status;

  if (status === 429) return new RateLimited({ retryAfter: retryAfter(response.headers) });

  if (status >= 500) return new Unavailable({ status });

  if (status === 403 || status === 404 || status === 410) {
    return new WebhookRevoked({ status, body });
  }

  // Any other 4xx means Slack rejected what we sent.
  return new InvalidPayload({ status, body });
};

const checkResponse = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<void, SlackError> {
  if (response.status >= 200 && response.status < 300) return;

  const body = yield* response.text.pipe(Effect.orElseSucceed(() => ""));

  return yield* new SlackError({ reason: reasonForStatus(response, body) });
});

const describeHttpError = ({ reason }: HttpClientError.HttpClientError): string =>
  reason.description === undefined ? reason._tag : `${reason._tag}: ${reason.description}`;

const transportError = (cause: string) => new SlackError({ reason: new Transport({ cause }) });

// Exponential backoff from 1s with jitter, at most 4 retries. Rate-limited
// attempts wait for Slack's Retry-After instead.
const retrySchedule = Schedule.exponential("1 second").pipe(
  Schedule.jittered,
  Schedule.setInputType<SlackError>(),
  Schedule.modifyDelay(({ input, duration }) =>
    Effect.succeed(input.reason instanceof RateLimited ? input.reason.retryAfter : duration),
  ),
  Schedule.while(({ input }) => isRetryable(input.reason)),
  Schedule.upTo({ times: 4 }),
  Schedule.tap(({ input, attempt, duration }) =>
    Effect.logInfo("Retrying Slack post").pipe(
      Effect.annotateLogs({
        reason: input.reason._tag,
        attempt,
        delayMs: Duration.toMillis(duration),
      }),
    ),
  ),
);

export class SlackNotifier extends Context.Service<
  SlackNotifier,
  {
    notify(event: OfficeEvent): Effect.Effect<void, SlackError>;
  }
>()("virtual-office-notifier/SlackNotifier") {
  static readonly layerNoDeps = Layer.effect(
    SlackNotifier,
    Effect.gen(function* () {
      const { webhookUrl } = yield* SlackConfig;
      const client = yield* HttpClient.HttpClient;
      const headlines = yield* HeadlineWriter;

      const post = (message: SlackMessage) =>
        HttpClientRequest.post(Redacted.value(webhookUrl)).pipe(
          HttpClientRequest.bodyJsonUnsafe(message),
          client.execute,
          Effect.timeout("10 seconds"),
          Effect.catchTags({
            HttpClientError: (error) => Effect.fail(transportError(describeHttpError(error))),
            TimeoutError: () => Effect.fail(transportError("Timed out after 10 seconds")),
          }),
          Effect.flatMap(checkResponse),
          Effect.withSpan("SlackNotifier.post"),
        );

      const notify = Effect.fn("SlackNotifier.notify")(function* (event: OfficeEvent) {
        // Both picked once, so a retry posts the same wording.
        const variant = yield* Random.nextInt;

        const generated = yield* headlines.write(event);

        yield* post(formatMessage(event, variant, generated)).pipe(Effect.retry(retrySchedule));
      });

      return SlackNotifier.of({ notify });
    }),
  );

  static readonly layer = SlackNotifier.layerNoDeps.pipe(
    Layer.provide(NodeHttpClient.layerUndici),
    Layer.provide(HeadlineWriter.layer),
  );
}
