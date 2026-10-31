import { getClipSelectionControl } from "@narriflow/services/clip-selection-runtime";
import { createSyntheticSelectionStorage } from "../../../../packages/services/scripts/gates/clip-selection-memory-storage";
import { createSelectionMemoryControl, type SelectionMemoryMetadata } from "./selection-memory-control";

(globalThis as unknown as { __selectionMemoryProbe: string; __selectionRuntimeFactory: unknown }).__selectionMemoryProbe = "narriflow-selection-memory-probe";
(globalThis as unknown as { __selectionRuntimeFactory: unknown }).__selectionRuntimeFactory = getClipSelectionControl;

export default {
  async fetch(request: Request, env: { FIXTURE_ORIGIN: string; CONCURRENCY: string }) {
    if (new URL(request.url).pathname === "/__warmup") return Response.json({ probe: "narriflow-selection-memory-probe" });
    const concurrency = Number(env.CONCURRENCY);
    if (!/^http:\/\/127\.0\.0\.1:[0-9]+$/.test(env.FIXTURE_ORIGIN) || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 6) return new Response(null, { status: 400 });
    const fixture = await (await fetch(`${env.FIXTURE_ORIGIN}/metadata`)).json() as SelectionMemoryMetadata;
    const storage = createSyntheticSelectionStorage(env.FIXTURE_ORIGIN);
    const execution = createSelectionMemoryControl(fixture, storage, init => fetch(`${env.FIXTURE_ORIGIN}/provider`, init));
    const started = Date.now();
    const outcomes = await Promise.all(fixture.windows.slice(0, concurrency).map(window => execution.control.runWindow(window.reference)));
    return Response.json({ sourceSeconds: fixture.sourceSeconds, words: fixture.words, utterances: fixture.utterances, inputBytes: fixture.inputBytes, concurrency, calls: execution.calls(), wallMs: Date.now() - started, outcomes });
  },
};
