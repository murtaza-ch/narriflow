import { afterEach, expect, test } from "bun:test";
import { OBJECT_URL_LIFETIME_MS, saveBlob } from "./download";

const globals = globalThis as unknown as Record<string, unknown>;
const original = { document: globals.document, URL: globals.URL, setTimeout: globals.setTimeout };

afterEach(() => {
  globals.document = original.document;
  globals.URL = original.URL;
  globals.setTimeout = original.setTimeout;
});

test("a saved file keeps its object URL until well after the click", () => {
  const events: string[] = [];
  const timers: Array<{ ms: number; run(): void }> = [];
  const anchor = {
    href: "",
    download: "",
    click: () => events.push(`click:${anchor.href}:${anchor.download}`),
    remove: () => events.push("remove"),
  };
  globals.document = { createElement: () => anchor, body: { appendChild: () => events.push("append") } };
  globals.URL = Object.assign(function URL() {}, {
    createObjectURL: () => "blob:test",
    revokeObjectURL: (url: string) => events.push(`revoke:${url}`),
  });
  globals.setTimeout = ((run: () => void, ms: number) => {
    timers.push({ ms, run });
    return 0;
  }) as unknown as typeof setTimeout;

  saveBlob(new Blob(["x"]), "clip.srt");

  expect(events).toEqual(["append", "click:blob:test:clip.srt", "remove"]);
  expect(timers).toHaveLength(1);
  expect(timers[0]?.ms).toBe(OBJECT_URL_LIFETIME_MS);
  timers[0]?.run();
  expect(events.at(-1)).toBe("revoke:blob:test");
});
