import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { ObservabilityLayer } from "./Observability.ts";
import { MainLayer, program } from "./Program.ts";

program.pipe(
  Effect.provide(MainLayer),
  // Inside the observability layer, so a crash, even at startup, is reported
  // and flushed before the process exits.
  Effect.withErrorReporting,
  Effect.provide(ObservabilityLayer),
  NodeRuntime.runMain,
);
