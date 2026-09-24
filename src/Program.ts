import { Effect, Layer, Stream } from "effect";

import { DiscordGateway } from "./DiscordGateway.ts";
import { isRetryable, type SlackError, SlackNotifier } from "./SlackNotifier.ts";

const logSlackError = (error: SlackError) =>
  (isRetryable(error.reason)
    ? Effect.logWarning("Gave up posting to Slack after retries", error.reason)
    : Effect.logError("Slack rejected the post", error.reason)
  ).pipe(Effect.annotateLogs({ outcome: "failed", reason: error.reason._tag }));

// Joins are handled one at a time, so a join that arrives during a retry waits
// its turn and messages stay in order.
export const program = Effect.gen(function* () {
  const gateway = yield* DiscordGateway;
  const slack = yield* SlackNotifier;

  yield* Effect.logInfo("Watching the virtual office");

  yield* Stream.runForEach(gateway.voiceJoins, (join) =>
    slack.notify(join).pipe(
      Effect.andThen(Effect.logInfo("Announced office join").pipe(Effect.annotateLogs({ outcome: "posted" }))),
      Effect.catchTag("SlackError", logSlackError),
      Effect.annotateLogs({ userId: join.userId }),
    ),
  );
});

// Slack is built first, so a missing webhook URL fails before logging in to
// Discord.
export const MainLayer = DiscordGateway.layer.pipe(Layer.provideMerge(SlackNotifier.layer));
