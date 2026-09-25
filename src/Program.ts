import { Effect, Layer, Option, Stream } from "effect";

import { DiscordGateway } from "./DiscordGateway.ts";
import { OfficeEvent } from "./OfficeEvent.ts";
import { reminders } from "./Reminder.ts";
import { isRetryable, type SlackError, SlackNotifier } from "./SlackNotifier.ts";

const logSlackError = (error: SlackError) =>
  (isRetryable(error.reason)
    ? Effect.logWarning("Gave up posting to Slack after retries", error.reason)
    : Effect.logError("Slack rejected the post", error.reason)
  ).pipe(Effect.annotateLogs({ outcome: "failed", reason: error.reason._tag }));

const eventAnnotations = OfficeEvent.$match({
  Opened: ({ userId }) => ({ event: "Opened", userId }),
  Emptied: ({ userId }) => ({ event: "Emptied", userId }),
  Reminder: () => ({ event: "Reminder" }),
});

// Events are handled one at a time, so one that arrives during a retry waits
// its turn and messages stay in order.
export const program = Effect.gen(function* () {
  const gateway = yield* DiscordGateway;
  const slack = yield* SlackNotifier;

  yield* Effect.logInfo("Watching the virtual office");

  // The reminders never end, so the program runs as long as the Discord events do.
  const events = gateway.officeEvents.pipe(
    Stream.merge(Option.match(gateway.office, { onNone: () => Stream.empty, onSome: reminders }), {
      haltStrategy: "left",
    }),
  );

  yield* Stream.runForEach(events, (event) =>
    slack.notify(event).pipe(
      Effect.andThen(Effect.logInfo("Announced office event").pipe(Effect.annotateLogs({ outcome: "posted" }))),
      Effect.catchTag("SlackError", logSlackError),
      Effect.annotateLogs(eventAnnotations(event)),
    ),
  );
});

// Slack is built first, so a missing webhook URL fails before logging in to
// Discord.
export const MainLayer = DiscordGateway.layer.pipe(Layer.provideMerge(SlackNotifier.layer));
