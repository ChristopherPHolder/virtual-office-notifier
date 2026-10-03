import * as Sentry from "@sentry/effect/server";
import { Effect, Layer, Logger, Option, Redacted, Tracer } from "effect";
import { constTrue } from "effect/Function";
import { HttpClient } from "effect/http";

import { SentryConfig } from "./Config.ts";

// Sends logs, traces and reported errors to Sentry, and flushes them on shutdown.
export const layerSentry = (options: Sentry.EffectServerLayerOptions) =>
  Layer.mergeAll(
    Sentry.effectLayer(options),
    Layer.succeed(Tracer.Tracer, Sentry.SentryEffectTracer),
    // Alongside the console logger, so the journal keeps every line too.
    Logger.layer([Sentry.SentryEffectLogger], { mergeWithExisting: true }),
    // HTTP client spans record the full request URL, and the Slack webhook URL
    // is a secret. The Effect AI spans already record each model call.
    Layer.succeed(HttpClient.TracerDisabledWhen, constTrue),
    Layer.effectDiscard(Effect.addFinalizer(() => Effect.promise(() => Sentry.close(2000)))),
  );

export const ObservabilityLayer = Layer.unwrap(
  Effect.gen(function* () {
    const { dsn, environment, release } = yield* SentryConfig;

    return Option.match(dsn, {
      onNone: () => Layer.empty,
      onSome: (dsn) =>
        layerSentry({
          dsn: Redacted.value(dsn),
          environment,
          release: Option.getOrUndefined(release),
          // A handful of events a day, so every trace is kept.
          tracesSampleRate: 1,
        }),
    });
  }),
);
