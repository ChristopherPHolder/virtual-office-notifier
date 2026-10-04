import { assert, describe, it } from "@effect/vitest";
import { DateTime, type Duration, Effect, Fiber, Layer, Ref, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  BANTER_PERIODS,
  banter,
  banterLog,
  isBanterTime,
  MAX_BANTER_PER_DAY,
  periodRange,
  startOfOfficeDay,
} from "../src/Banter.ts";
import { type BanterContext, type BanterPeriod, OfficeEvent } from "../src/OfficeEvent.ts";
import { HistoryUnavailable, OfficeHistory } from "../src/OfficeHistory.ts";
import { firstVariant } from "./fakes.ts";

const office = { guildId: "g1", channelId: "c1" };

// Office time is UTC+2, so 2026-10-02T14:05+02:00 is a Friday afternoon.
const officeTime = (iso: string) => DateTime.makeUnsafe(`${iso}+02:00`);

const iso = (at: DateTime.Utc) => DateTime.formatIso(at);

describe("isBanterTime", () => {
  it.each([
    { at: "2026-10-02T09:00:00", expected: true, why: "the start of a Friday" },
    { at: "2026-10-02T17:59:00", expected: true, why: "just before 18:00 on a Friday" },
    { at: "2026-09-28T12:00:00", expected: true, why: "midday on a Monday" },
    { at: "2026-10-02T08:59:00", expected: false, why: "just before 09:00" },
    { at: "2026-10-02T18:00:00", expected: false, why: "18:00" },
    { at: "2026-10-03T12:00:00", expected: false, why: "a Saturday" },
    { at: "2026-10-04T12:00:00", expected: false, why: "a Sunday" },
  ])("is $expected at $why, in office time", ({ at, expected }) => {
    assert.strictEqual(isBanterTime(officeTime(at)), expected);
  });

  it("follows office time rather than UTC", () => {
    assert.isTrue(isBanterTime(DateTime.makeUnsafe("2026-10-02T07:00:00Z")));
    assert.isFalse(isBanterTime(DateTime.makeUnsafe("2026-10-02T16:00:00Z")));
  });
});

describe("periodRange", () => {
  const friday = officeTime("2026-10-02T14:05:00");

  it.each([
    { period: "Today", from: "2026-10-02T00:00:00", until: "2026-10-02T14:05:00" },
    { period: "SinceYesterday", from: "2026-10-01T00:00:00", until: "2026-10-02T14:05:00" },
    { period: "ThisWeek", from: "2026-09-28T00:00:00", until: "2026-10-02T14:05:00" },
    { period: "LastWeek", from: "2026-09-21T00:00:00", until: "2026-09-28T00:00:00" },
  ] satisfies ReadonlyArray<{ period: BanterPeriod; from: string; until: string }>)(
    "covers $period in office days, with weeks from Monday",
    ({ period, from, until }) => {
      const range = periodRange(period, friday);

      assert.strictEqual(iso(range.from), iso(officeTime(from)));
      assert.strictEqual(iso(range.until), iso(officeTime(until)));
    },
  );

  it("starts this week today on a Monday", () => {
    const monday = officeTime("2026-09-28T10:00:00");

    assert.strictEqual(iso(periodRange("ThisWeek", monday).from), iso(startOfOfficeDay(monday)));
  });
});

describe("banterLog", () => {
  const context: BanterContext = {
    at: officeTime("2026-10-02T14:05:00"),
    period: "Today",
    activityOldestFirst: [
      { at: officeTime("2026-10-02T08:47:00"), who: "Ada", event: "Joined" },
      { at: officeTime("2026-10-02T09:31:00"), who: "Grace Hopper", event: "CameraOn" },
    ],
    olderEntriesLeftOut: 0,
    present: ["Ada", "Grace Hopper"],
  };

  it("gives the model the time, who's in and every entry in office time", () => {
    assert.strictEqual(
      banterLog(context),
      [
        "It's Fri 2 Oct 14:05 (UTC+2).",
        "In the office right now: Ada, Grace Hopper.",
        "Here's everything that happened in the office today so far, with times in UTC+2:",
        "Fri 2 Oct 08:47 Ada Joined",
        "Fri 2 Oct 09:31 Grace Hopper CameraOn",
      ].join("\n"),
    );
  });

  it("says when the office is empty and nothing happened", () => {
    assert.strictEqual(
      banterLog({ ...context, period: "LastWeek", activityOldestFirst: [], present: [] }),
      [
        "It's Fri 2 Oct 14:05 (UTC+2).",
        "Nobody's in the office right now.",
        "Nothing happened in the office last week.",
      ].join("\n"),
    );
  });

  it("says how many earlier entries were left out", () => {
    assert.include(
      banterLog({ ...context, olderEntriesLeftOut: 12 }),
      "Here are the latest 2 things that happened in the office today so far, with times in UTC+2. 12 earlier ones are left out:",
    );
  });
});

interface FakeHistory {
  readonly postsAlreadyToday?: number;
  readonly unavailable?: boolean;
}

const makeFakeHistory = Effect.fnUntraced(function* ({ postsAlreadyToday = 0, unavailable = false }: FakeHistory) {
  const posts = yield* Ref.make<ReadonlyArray<{ readonly at: DateTime.Utc; readonly period: BanterPeriod }>>([]);
  const fail = Effect.fail(new HistoryUnavailable({ reason: "Database down" }));

  const layer = Layer.succeed(
    OfficeHistory,
    OfficeHistory.of({
      latestActivityBetween: (from) =>
        unavailable
          ? fail
          : Effect.succeed({ entriesOldestFirst: [{ at: from, who: "Ada", event: "Joined" }], olderEntriesLeftOut: 3 }),
      presentSinceBotStarted: unavailable ? fail : Effect.succeed(["Ada"]),
      banterPostsSince: (from) =>
        unavailable
          ? fail
          : Ref.get(posts).pipe(
              Effect.map(
                (recorded) =>
                  postsAlreadyToday + recorded.filter(({ at }) => DateTime.isGreaterThanOrEqualTo(at, from)).length,
              ),
            ),
      recordBanterPost: (at, period) => Ref.update(posts, (recorded) => [...recorded, { at, period }]),
    }),
  );

  return { layer, posts: Ref.get(posts) };
});

// Collects the banter emitted while the test clock runs for `duration`. The
// test clock starts at 1970-01-01T00:00Z, a Thursday, which is 02:00 office
// time, and the first-variant random source waits the shortest gap, an hour.
const collectBanter = Effect.fnUntraced(function* (history: FakeHistory, duration: Duration.Input) {
  const fake = yield* makeFakeHistory(history);
  const emitted = yield* Ref.make<ReadonlyArray<OfficeEvent>>([]);

  const fiber = yield* banter(office).pipe(
    Stream.runForEach((event) => Ref.update(emitted, (all) => [...all, event])),
    Effect.provide(fake.layer),
    firstVariant,
    Effect.forkChild,
  );

  yield* Effect.repeat(Effect.yieldNow, { times: 10 });
  yield* TestClock.adjust(duration);
  yield* Fiber.interrupt(fiber);

  return { emitted: yield* Ref.get(emitted), posts: yield* fake.posts };
});

describe("banter", () => {
  it.effect("waits for office hours, then posts at most five a day", () =>
    Effect.gen(function* () {
      const { emitted, posts } = yield* collectBanter({}, "24 hours");

      assert.strictEqual(emitted.length, MAX_BANTER_PER_DAY);
      assert.deepStrictEqual(
        posts.map(({ at }) => iso(at)),
        ["07:00", "08:00", "09:00", "10:00", "11:00"].map((time) => `1970-01-01T${time}:00.000Z`),
      );
    }));

  it.effect("hands the model the period's activity and who's in", () =>
    Effect.gen(function* () {
      const { emitted } = yield* collectBanter({}, "8 hours");

      const [first] = emitted;

      assert.isTrue(first !== undefined && OfficeEvent.$is("Banter")(first));
      assert.deepInclude(first, {
        ...office,
        period: BANTER_PERIODS[0],
        olderEntriesLeftOut: 3,
        present: ["Ada"],
      });
    }));

  it.effect("counts what was already posted today, so a restart doesn't reset the limit", () =>
    Effect.gen(function* () {
      const { emitted } = yield* collectBanter({ postsAlreadyToday: MAX_BANTER_PER_DAY - 1 }, "24 hours");

      assert.strictEqual(emitted.length, 1);
    }));

  it.effect("stays quiet at the weekend", () =>
    Effect.gen(function* () {
      const { emitted } = yield* collectBanter({}, "72 hours");

      assert.strictEqual(emitted.length, MAX_BANTER_PER_DAY * 2);
    }));

  it.effect("skips its chance without failing when the history can't be read", () =>
    Effect.gen(function* () {
      const { emitted, posts } = yield* collectBanter({ unavailable: true }, "24 hours");

      assert.deepStrictEqual(emitted, []);
      assert.deepStrictEqual(posts, []);
    }));
});
