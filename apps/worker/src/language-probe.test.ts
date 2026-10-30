import { describe, expect, test } from "bun:test";
import {
  buildProbeFfmpegArgs,
  decideProbePin,
  probeSourceLanguage,
  selectProbeWindows,
} from "./language-probe";
import type { WorkerProcessModule, WorkerProcessRequest } from "./worker-process";

describe("selectProbeWindows", () => {
  test("is null below 60 s", () => {
    expect(selectProbeWindows(59.9)).toBeNull();
    expect(selectProbeWindows(Number.NaN)).toBeNull();
  });

  test("tiles a 60 s source", () => {
    expect(selectProbeWindows(60)?.map((w) => w.startSec)).toEqual([0, 20, 40]);
  });

  test("centres windows at 20/50/80% of 10 minutes", () => {
    expect(selectProbeWindows(600)?.map((w) => w.startSec)).toEqual([110, 290, 470]);
  });

  test("centres windows at 20/50/80% of 3 hours", () => {
    expect(selectProbeWindows(10_800)?.map((w) => w.startSec)).toEqual([2150, 5390, 8630]);
  });

  test("windows never overlap or leave the source", () => {
    for (let duration = 60; duration <= 200; duration += 0.7) {
      const windows = selectProbeWindows(duration)!;
      for (const [index, window] of windows.entries()) {
        expect(window.startSec).toBeGreaterThanOrEqual(0);
        expect(window.startSec + window.durationSec).toBeLessThanOrEqual(duration + 1e-6);
        if (index > 0) {
          const previous = windows[index - 1]!;
          expect(window.startSec).toBeGreaterThanOrEqual(previous.startSec + previous.durationSec - 1e-6);
        }
      }
    }
  });
});

describe("decideProbePin", () => {
  const confident = { languageCode: "urd", probability: 0.97, wordCount: 80 };

  test("pins a confident, wordy, catalogued detection and maps the provider code", () => {
    expect(decideProbePin({ ...confident, languageCode: "tam" })).toEqual({ pinned: "ta", reason: "pinned" });
    expect(decideProbePin({ ...confident, languageCode: "eng" }).pinned).toBe("en");
    expect(decideProbePin({ ...confident, languageCode: "cmn" }).pinned).toBe("zh");
  });

  test("thresholds are inclusive", () => {
    expect(decideProbePin({ ...confident, languageCode: "eng", probability: 0.8, wordCount: 15 }).pinned).toBe("en");
  });

  test("never pins Hindi or Urdu: Scribe hears Urdu speech as Hindi", () => {
    for (const languageCode of ["hin", "urd", "hi", "ur"]) {
      expect(decideProbePin({ ...confident, languageCode })).toEqual({ pinned: null, reason: "hindi_urdu_ambiguous" });
    }
  });

  test("declines each way it can be unsure", () => {
    expect(decideProbePin({ ...confident, probability: 0.79 })).toEqual({
      pinned: null,
      reason: "low_language_probability",
    });
    expect(decideProbePin({ ...confident, probability: null }).pinned).toBeNull();
    expect(decideProbePin({ ...confident, wordCount: 14 })).toEqual({ pinned: null, reason: "too_few_words" });
    expect(decideProbePin({ ...confident, languageCode: "xxx" })).toEqual({
      pinned: null,
      reason: "language_not_in_catalog",
    });
    expect(decideProbePin({ ...confident, languageCode: null }).reason).toBe("no_language_detected");
  });
});

describe("buildProbeFfmpegArgs", () => {
  test("seeks each window on the URL before reading it and emits mono 16 kHz", () => {
    const windows = selectProbeWindows(600)!;
    const args = buildProbeFfmpegArgs("https://r2.example/source.mp4?sig=1", windows, "/tmp/out.wav");
    const inputs = args.flatMap((arg, index) => (arg === "-i" ? [index] : []));
    expect(inputs).toHaveLength(3);
    for (const [n, index] of inputs.entries()) {
      expect(args.slice(index - 4, index + 2)).toEqual([
        "-ss", String(windows[n]!.startSec), "-t", "20", "-i", "https://r2.example/source.mp4?sig=1",
      ]);
      expect(args[index - 6]).toBe("-rw_timeout");
    }
    expect(args.join(" ")).toContain("concat=n=3:v=0:a=1");
    expect(args.slice(-7)).toEqual(["-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", "/tmp/out.wav"]);
  });
});

function fakeProcess(execute: (request: WorkerProcessRequest) => Promise<void>): WorkerProcessModule {
  return {
    execute: async (request) => {
      await execute(request);
      const output = request.args.at(-1)!;
      await Bun.write(output, "RIFFfake");
      return { exitCode: 0, stdout: Buffer.alloc(0) };
    },
    withScratchDirectory: async (prefix, work) => {
      const { mkdtemp, rm } = await import("node:fs/promises");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const directory = await mkdtemp(join(tmpdir(), prefix));
      try {
        return await work(directory);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  } as unknown as WorkerProcessModule;
}

const words = (n: number) => Array.from({ length: n }, () => ({ text: "x", type: "word" }));
const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("probeSourceLanguage", () => {
  const base = {
    sourceUrl: "https://r2.example/source.mp4",
    durationSeconds: 600,
    apiKey: "test-key",
  };

  test("pins Tamil and posts the documented multipart request", async () => {
    let seen: { url: string; headers: Headers; form: FormData } | undefined;
    const result = await probeSourceLanguage({
      ...base,
      signal: new AbortController().signal,
      workerProcess: fakeProcess(async () => {}),
      fetch: (async (url: string, init: RequestInit) => {
        seen = { url, headers: new Headers(init.headers), form: init.body as FormData };
        return jsonResponse({
          language_code: "tam",
          language_probability: 0.99,
          words: [...words(30), { text: " ", type: "spacing" }],
        });
      }) as unknown as typeof fetch,
    });
    expect(result).toEqual({ pinned: "ta", detected: "tam", probability: 0.99, wordCount: 30, reason: "pinned" });
    expect(seen?.url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(seen?.headers.get("xi-api-key")).toBe("test-key");
    expect(seen?.form.get("model_id")).toBe("scribe_v2");
    expect(seen?.form.get("tag_audio_events")).toBe("false");
    expect(seen?.form.has("diarize")).toBe(false);
    expect(seen?.form.get("file")).toBeInstanceOf(Blob);
  });

  test("skips short sources and a missing key without calling anything", async () => {
    const never = fakeProcess(async () => {
      throw new Error("must not run");
    });
    const signal = new AbortController().signal;
    expect((await probeSourceLanguage({ ...base, durationSeconds: 30, signal, workerProcess: never })).reason).toBe(
      "source_too_short",
    );
    const previous = process.env.ELEVENLABS_API_KEY;
    delete process.env.ELEVENLABS_API_KEY;
    try {
      const result = await probeSourceLanguage({ ...base, apiKey: undefined, signal, workerProcess: never });
      expect(result).toMatchObject({ pinned: null, reason: "provider_not_configured" });
    } finally {
      if (previous !== undefined) process.env.ELEVENLABS_API_KEY = previous;
    }
  });

  test("a low-confidence answer keeps what was detected but does not pin", async () => {
    const result = await probeSourceLanguage({
      ...base,
      signal: new AbortController().signal,
      workerProcess: fakeProcess(async () => {}),
      fetch: (async () =>
        jsonResponse({ language_code: "hin", language_probability: 0.55, words: words(40) })) as unknown as typeof fetch,
    });
    expect(result).toEqual({
      pinned: null,
      detected: "hin",
      probability: 0.55,
      wordCount: 40,
      reason: "low_language_probability",
    });
  });

  test("ffmpeg, HTTP, network and malformed-body failures return unpinned instead of throwing", async () => {
    const signal = new AbortController().signal;
    const ok = fakeProcess(async () => {});
    const run = (workerProcess: WorkerProcessModule, fetchImpl: unknown) =>
      probeSourceLanguage({ ...base, signal, workerProcess, fetch: fetchImpl as typeof fetch });

    expect(
      await run(fakeProcess(async () => { throw new Error("ffmpeg exited 1"); }), async () => jsonResponse({})),
    ).toMatchObject({ pinned: null, reason: "probe_failed" });
    expect(await run(ok, async () => jsonResponse({ detail: "quota" }, 401))).toMatchObject({
      pinned: null,
      reason: "provider_http_401",
    });
    expect(await run(ok, async () => { throw new TypeError("fetch failed"); })).toMatchObject({
      pinned: null,
      reason: "probe_failed",
    });
    expect(await run(ok, async () => new Response("not json", { status: 200 }))).toMatchObject({
      pinned: null,
      reason: "probe_failed",
    });
  });

  test("cancellation propagates instead of being reported as a probe failure", async () => {
    const controller = new AbortController();
    const reason = new Error("lease lost");
    const workerProcess = fakeProcess(async () => {
      controller.abort(reason);
      throw reason;
    });
    await expect(
      probeSourceLanguage({ ...base, signal: controller.signal, workerProcess }),
    ).rejects.toBe(reason);
    await expect(
      probeSourceLanguage({ ...base, signal: controller.signal, workerProcess }),
    ).rejects.toBe(reason);
  });
});
