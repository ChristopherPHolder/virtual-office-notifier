import { assert, describe, it } from "@effect/vitest";
import { Clock, DateTime, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";

import { OfficeEvent } from "../src/OfficeEvent.ts";
import { reminders } from "../src/Reminder.ts";

const office = { guildId: "g1", channelId: "c1" };

describe("reminders", () => {
  it.effect("fires on weekdays at 11:15 UTC+2", () =>
    Effect.gen(function* () {
      // The test clock starts at 1970-01-01T00:00Z, a Thursday.
      const fiber = yield* reminders(office).pipe(
        Stream.take(3),
        Stream.mapEffect((event) => Clock.currentTimeMillis.pipe(Effect.map((now) => [event, now] as const))),
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* TestClock.adjust("7 days");
      const fired = yield* Fiber.join(fiber);

      assert.deepStrictEqual(
        fired.map(([, now]) => new Date(now).toISOString()),
        ["1970-01-01T09:15:00.000Z", "1970-01-02T09:15:00.000Z", "1970-01-05T09:15:00.000Z"],
      );
      assert.deepStrictEqual(
        fired[0]?.[0],
        OfficeEvent.Reminder({ ...office, at: DateTime.makeUnsafe("1970-01-01T09:15:00Z") }),
      );
    }));

  it.effect("stays quiet before the first reminder is due", () =>
    Effect.gen(function* () {
      const fiber = yield* reminders(office).pipe(Stream.take(1), Stream.runCollect, Effect.forkChild);

      yield* TestClock.adjust("9 hours");
      assert.isUndefined(fiber.pollUnsafe());

      yield* TestClock.adjust("15 minutes");
      assert.strictEqual((yield* Fiber.join(fiber)).length, 1);
    }));
});
