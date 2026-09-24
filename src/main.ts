import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";

import { MainLayer, program } from "./Program.ts";

program.pipe(Effect.provide(MainLayer), NodeRuntime.runMain);
