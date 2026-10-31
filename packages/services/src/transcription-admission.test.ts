import { expect, test } from "bun:test";
import { scribeConcurrencyUnits, createTranscriptionAdmission } from "./transcription-admission";

test("Scribe weights exact measured duration at each provider boundary and caps at four units", () => {
  for (const [seconds, units] of [[0.01, 1], [480, 1], [480.01, 2], [960, 2], [960.01, 3], [1440, 3], [1440.01, 4], [10800, 4]]) {
    expect(scribeConcurrencyUnits(seconds!)).toBe(units!);
  }
  for (const invalid of [0, -1, NaN, Infinity]) expect(() => scribeConcurrencyUnits(invalid)).toThrow();
});

test("provider admission requires an explicit verified positive concurrency cap", () => {
  for (const maxUnits of [undefined, 0, NaN, Infinity, 1.5]) {
    expect(() => createTranscriptionAdmission({ database: {} as never, workflow: {} as never, maxUnits: maxUnits as number })).toThrow();
  }
});
