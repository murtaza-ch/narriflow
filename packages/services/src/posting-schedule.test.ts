import { describe, expect, test } from "bun:test";
import { nextFreeSlots, postingSlotInstants } from "./posting-schedule";

const sundayNine = { slots: [{ weekday: "sun" as const, time: "09:00" }] };
const iso = (dates: Date[]) => dates.map((date) => date.toISOString());

describe("posting slots across daylight saving time", () => {
  test("a weekly slot keeps its local time when the clock springs forward", () => {
    // New York moves from UTC-5 to UTC-4 on Sunday 2026-03-08.
    const slots = nextFreeSlots({ schedule: sundayNine, timeZone: "America/New_York", after: new Date("2026-02-27T00:00:00Z"), occupied: new Set(), count: 3 });
    expect(iso(slots)).toEqual([
      "2026-03-01T14:00:00.000Z", // 09:00 EST
      "2026-03-08T13:00:00.000Z", // 09:00 EDT, an hour earlier in UTC
      "2026-03-15T13:00:00.000Z",
    ]);
  });

  test("a weekly slot keeps its local time when the clock falls back", () => {
    // New York moves from UTC-4 to UTC-5 on Sunday 2026-11-01.
    const slots = nextFreeSlots({ schedule: sundayNine, timeZone: "America/New_York", after: new Date("2026-10-23T00:00:00Z"), occupied: new Set(), count: 3 });
    expect(iso(slots)).toEqual([
      "2026-10-25T13:00:00.000Z", // 09:00 EDT
      "2026-11-01T14:00:00.000Z", // 09:00 EST, an hour later in UTC
      "2026-11-08T14:00:00.000Z",
    ]);
  });

  test("a time the clock skips moves to the instant it would have had", () => {
    const schedule = { slots: [{ weekday: "sun" as const, time: "02:30" }] };
    const slots = nextFreeSlots({ schedule, timeZone: "America/New_York", after: new Date("2026-03-01T12:00:00Z"), occupied: new Set(), count: 2 });
    expect(iso(slots)).toEqual([
      "2026-03-08T07:30:00.000Z", // 02:30 does not exist; 07:30Z is 02:30 EST and 03:30 EDT
      "2026-03-15T06:30:00.000Z", // 02:30 EDT
    ]);
  });

  test("a time skipped by a half-hour clock change moves by that half hour", () => {
    // Lord Howe Island moves from UTC+10:30 to UTC+11 at 02:00 on 2026-10-04, so 02:00 to 02:30 never happens.
    const schedule = { slots: [{ weekday: "sun" as const, time: "02:15" }] };
    const [skipped, next] = nextFreeSlots({ schedule, timeZone: "Australia/Lord_Howe", after: new Date("2026-09-27T00:00:00Z"), occupied: new Set(), count: 2 });
    expect(skipped!.toISOString()).toBe("2026-10-03T15:45:00.000Z"); // 02:45 at UTC+11
    expect(next!.toISOString()).toBe("2026-10-10T15:15:00.000Z"); // 02:15 at UTC+11 the week after
  });

  test("a time the clock repeats takes its first occurrence", () => {
    const schedule = { slots: [{ weekday: "sun" as const, time: "01:30" }] };
    const [slot] = nextFreeSlots({ schedule, timeZone: "America/New_York", after: new Date("2026-10-26T00:00:00Z"), occupied: new Set() });
    expect(slot!.toISOString()).toBe("2026-11-01T05:30:00.000Z"); // 01:30 EDT, before the clock falls back
  });

  test("a zone without daylight saving time never moves", () => {
    const slots = nextFreeSlots({ schedule: sundayNine, timeZone: "Asia/Karachi", after: new Date("2026-03-01T00:00:00Z"), occupied: new Set(), count: 2 });
    expect(iso(slots)).toEqual(["2026-03-01T04:00:00.000Z", "2026-03-08T04:00:00.000Z"]);
  });

  test("the local weekday decides the day, not the UTC date", () => {
    // 09:00 Monday in Auckland is still Sunday in UTC.
    const [slot] = nextFreeSlots({ schedule: { slots: [{ weekday: "mon", time: "09:00" }] }, timeZone: "Pacific/Auckland", after: new Date("2026-06-01T00:00:00Z"), occupied: new Set() });
    expect(slot!.toISOString()).toBe("2026-06-07T21:00:00.000Z");
  });
});

describe("next free slot", () => {
  const schedule = { slots: [{ weekday: "mon" as const, time: "09:00" }, { weekday: "wed" as const, time: "09:00" }, { weekday: "wed" as const, time: "17:30" }] };
  const after = new Date("2026-07-05T12:00:00Z"); // a Sunday

  test("lists slots earliest first, several in one day", () => {
    expect(iso(nextFreeSlots({ schedule, timeZone: "UTC", after, occupied: new Set(), count: 4 }))).toEqual([
      "2026-07-06T09:00:00.000Z",
      "2026-07-08T09:00:00.000Z",
      "2026-07-08T17:30:00.000Z",
      "2026-07-13T09:00:00.000Z",
    ]);
  });

  test("skips a slot only when another post is at exactly that instant", () => {
    const occupied = new Set([Date.parse("2026-07-06T09:00:00Z"), Date.parse("2026-07-08T09:01:00Z")]);
    const [first, second] = nextFreeSlots({ schedule, timeZone: "UTC", after, occupied, count: 2 });
    expect(first!.toISOString()).toBe("2026-07-08T09:00:00.000Z");
    expect(second!.toISOString()).toBe("2026-07-08T17:30:00.000Z");
  });

  test("never offers a slot at or before the moment asked from", () => {
    const [slot] = nextFreeSlots({ schedule, timeZone: "UTC", after: new Date("2026-07-06T09:00:00Z"), occupied: new Set() });
    expect(slot!.toISOString()).toBe("2026-07-08T09:00:00.000Z");
  });

  test("an empty schedule has no slots", () => {
    expect(nextFreeSlots({ schedule: { slots: [] }, timeZone: "UTC", after, occupied: new Set() })).toEqual([]);
    expect([...postingSlotInstants({ slots: [] }, "UTC", after)]).toEqual([]);
  });

  test("gives fewer slots than asked when the horizon runs out", () => {
    const week = Date.parse("2026-07-06T09:00:00Z");
    const occupied = new Set(Array.from({ length: 80 }, (_, index) => week + index * 7 * 24 * 60 * 60 * 1000));
    expect(nextFreeSlots({ schedule: { slots: [{ weekday: "mon", time: "09:00" }] }, timeZone: "UTC", after, occupied })).toEqual([]);
  });
});
