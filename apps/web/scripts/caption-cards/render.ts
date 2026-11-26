/**
 * Records the caption preset cards' samples as looping clips (`public/caption-cards/<preset>.mp4`) and posters
 * (`<preset>.webp`), and writes `app/(app)/_shared/caption-card-clips.json`.
 *
 * Each frame is the real painter's drawing on the dev-only `/prototype/caption-cards` page, stepped to an exact time,
 * so a clip shows what the live card drew. Needs the web dev server (`bun run --cwd apps/web dev`), Google Chrome and
 * ffmpeg with libx264 and libwebp.
 *
 *   bun run --cwd apps/web cards:render -- --stale        presets whose clip is missing or out of date (the default)
 *   bun run --cwd apps/web cards:render -- --all          every carded preset
 *   bun run --cwd apps/web cards:render -- ledge bento    these presets
 *   options: --base http://localhost:3000  --jobs 2  CHROME=/path/to/chrome
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CAPTION_PRESETS, type NamedCaptionPreset } from "@narriflow/validators";
import { presetHasCardClip, type CaptionCardClipEntry } from "../../app/(app)/_shared/caption-card-clips";
import { CARD_FPS, CARD_WIDTH, captionCardSourceHash } from "./source-hash";

const WEB = join(import.meta.dir, "../..");
const OUT = join(WEB, "public/caption-cards");
const MANIFEST = join(WEB, "app/(app)/_shared/caption-card-clips.json");
const CHROME = process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const args = process.argv.slice(2);
const option = (name: string, fallback: string) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args.splice(at, 2)[1]! : fallback;
};
const flag = (name: string) => {
  const at = args.indexOf(`--${name}`);
  if (at >= 0) args.splice(at, 1);
  return at >= 0;
};
const base = option("base", "http://localhost:3000");
const jobs = Number(option("jobs", "2"));
const all = flag("all");
flag("stale");

const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as { cards: Record<string, CaptionCardClipEntry> };
const carded = CAPTION_PRESETS.filter((named) => presetHasCardClip(named.preset));
const stale = (named: NamedCaptionPreset) =>
  manifest.cards[named.id]?.hash !== captionCardSourceHash(named) || !existsSync(join(OUT, `${named.id}.mp4`)) || !existsSync(join(OUT, `${named.id}.webp`));
const wanted = args.length > 0 ? carded.filter((named) => args.includes(named.id)) : all ? carded : carded.filter(stale);
if (args.length > 0 && wanted.length !== args.length) throw new Error(`not a carded preset: ${args.filter((id) => !carded.some((named) => named.id === id)).join(", ")}`);
if (wanted.length === 0) {
  console.log("Every card clip is up to date.");
  process.exit(0);
}

function run(command: string, commandArgs: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`${command} exited ${code}: ${stderr.slice(-2000)}`))));
  });
}

// ─── Chrome over the DevTools protocol ───────────────────────────────────────

/**
 * One headless Chrome with one page. Each job gets its own: a page is only "visible" (lazy images load, animation
 * frames run, paints land) while it is the front tab of the front window, so pages sharing one browser record blank.
 */
interface Browser {
  evaluate<T>(expression: string): Promise<T>;
  send<T>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

async function launchBrowser(): Promise<Browser> {
  const profile = mkdtempSync(join(tmpdir(), "caption-cards-chrome-"));
  const port = 9300 + Math.floor(Math.random() * 600);
  const chrome = spawn(CHROME, [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    "--hide-scrollbars",
    "--mute-audio",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ], { stdio: "ignore" });
  let url: string | null = null;
  for (let attempt = 0; attempt < 100 && !url; attempt++) {
    try {
      url = ((await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
    } catch {
      await Bun.sleep(100);
    }
  }
  if (!url) throw new Error("Chrome did not start");
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 0;
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  socket.onmessage = (event) => {
    const message = JSON.parse(String(event.data)) as { id?: number; result?: unknown; error?: { message: string } };
    if (message.id === undefined) return;
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) waiter?.reject(new Error(message.error.message));
    else waiter?.resolve(message.result);
  };
  const raw = <T>(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<T> => {
    const id = ++nextId;
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    return new Promise<T>((resolve, reject) => pending.set(id, { resolve: resolve as (value: unknown) => void, reject }));
  };
  const { targetInfos } = await raw<{ targetInfos: { targetId: string; type: string }[] }>("Target.getTargets");
  const page = targetInfos.find((target) => target.type === "page");
  if (!page) throw new Error("Chrome has no page");
  const { sessionId } = await raw<{ sessionId: string }>("Target.attachToTarget", { targetId: page.targetId, flatten: true });
  const send = <T>(method: string, params: Record<string, unknown> = {}) => raw<T>(method, params, sessionId);
  await send("Page.enable");
  await send("Emulation.setFocusEmulationEnabled", { enabled: true });
  await send("Emulation.setDeviceMetricsOverride", { width: CARD_WIDTH + 40, height: 600, deviceScaleFactor: 2, mobile: false });
  return {
    send,
    async evaluate<T>(expression: string): Promise<T> {
      const result = await send<{ result: { value: T }; exceptionDetails?: { text: string } }>("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
      if (result.exceptionDetails) throw new Error(`${expression.slice(0, 120)}: ${result.exceptionDetails.text}`);
      return result.result.value;
    },
    close() {
      socket.close();
      chrome.kill();
      rmSync(profile, { recursive: true, force: true });
    },
  };
}

// ─── Recording ───────────────────────────────────────────────────────────────

const FRAMES = "new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))";

/** The page reloaded under a recording: its frames so far are not one take, so the card is recorded again. */
class Reloaded extends Error {
  constructor(id: string) {
    super(`${id}: the page reloaded while recording`);
  }
}

/** A reload, a page that navigated away, or one that never got ready (a reload mid-load) is retried; anything else is a real failure. */
async function recordWithRetries(browser: Browser, named: NamedCaptionPreset): Promise<CaptionCardClipEntry> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await record(browser, named);
    } catch (error) {
      const message = (error as Error).message;
      const transient = error instanceof Reloaded || /navigated or closed|never became ready/.test(message);
      if (!transient || attempt >= 4) throw error;
      console.log(`${named.id}: retrying (${message.slice(0, 80)})`);
    }
  }
}

async function record(browser: Browser, named: NamedCaptionPreset): Promise<CaptionCardClipEntry> {
  const { evaluate, send } = browser;
  const frames = mkdtempSync(join(tmpdir(), `caption-card-${named.id}-`));
  try {
    await send("Page.navigate", { url: `${base}/prototype/caption-cards?card=${encodeURIComponent(named.id)}&w=${CARD_WIDTH}` });
    // Ready: the control is up, the backdrop and fonts have loaded, and the painter has drawn its caption (scene pieces or
    // block words: fonts can report loaded before a painter has asked for its faces).
    const deadline = Date.now() + 120_000;
    for (;;) {
      const ready = await evaluate<boolean>(
        `(() => { const c = window.__card; const img = document.querySelector("[data-card-frame] img");
          const drawn = document.querySelector(c?.scene ? "[data-scene-piece]" : "[data-caption-block-word]");
          return document.visibilityState === "visible" && !!c && !!img && img.complete && img.naturalWidth > 0 && document.fonts.status === "loaded" && !!drawn && (!c.scene || c.faces !== null); })()`,
      ).catch(() => false);
      if (ready) break;
      if (Date.now() > deadline) {
        const state = await evaluate<string>(
          `JSON.stringify((() => { const c = window.__card; const img = document.querySelector("[data-card-frame] img");
            return { control: !!c, img: img ? { complete: img.complete, width: img.naturalWidth, src: img.currentSrc } : null, fonts: document.fonts.status, faces: c?.faces ?? null }; })())`,
        ).catch((error) => String(error));
        throw new Error(`${named.id}: the card never became ready ${state}`);
      }
      await Bun.sleep(100);
    }
    // Next's dev overlay (build errors, the dev indicator) draws over the page without reloading it: never record it.
    await evaluate(`(() => { const style = document.createElement("style"); style.textContent = "nextjs-portal { display: none !important; }"; document.head.append(style); })()`);
    await evaluate(`document.fonts.ready.then(() => ${FRAMES})`);
    const { loopSec, stillSec, faces } = await evaluate<{ loopSec: number; stillSec: number; faces: string[] | null }>(
      "({ loopSec: window.__card.loopSec, stillSec: window.__card.stillSec, faces: window.__card.faces })",
    );
    const box = await evaluate<{ x: number; y: number; width: number; height: number }>(
      `(() => { const r = document.querySelector("[data-card-frame]").getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`,
    );
    // The dev server hot-reloads on any edit in the checkout (other sessions edit too). A reload or remount replaces the
    // page's control and resets its painter, so each frame checks the control this recording tagged is still the one up.
    const take = crypto.randomUUID();
    await evaluate(`(window.__card.run = "${take}")`);
    const shoot = async (seconds: number, file: string) => {
      const same = await evaluate<boolean>(`window.__card?.run === "${take}" ? (window.__card.set(${seconds}), ${FRAMES}).then(() => true) : false`);
      const { data } = await send<{ data: string }>("Page.captureScreenshot", { format: "png", optimizeForSpeed: true, clip: { ...box, scale: 1 } });
      const after = await evaluate<boolean>(`window.__card?.run === "${take}"`);
      if (!same || !after) throw new Reloaded(named.id);
      writeFileSync(file, Buffer.from(data, "base64"));
    };
    const count = Math.round(loopSec * CARD_FPS);
    for (let frame = 0; frame < count; frame++) await shoot(frame / CARD_FPS, join(frames, `${String(frame).padStart(5, "0")}.png`));
    // The poster is the sample's still (what the live card showed with reduced motion). A few templates have already
    // cleared the cue at that moment (`captionSceneStillMs` lands in their exit), so it steps back to the latest
    // earlier frame that draws a caption.
    const drawnNow = () =>
      evaluate<boolean>(
        `[...document.querySelectorAll("[data-scene-piece], [data-caption-block-word]")].some((el) => getComputedStyle(el).visibility !== "hidden" && el.getBoundingClientRect().width > 0 && Number(getComputedStyle(el).opacity) > 0)`,
      );
    let posterSec = stillSec;
    await shoot(posterSec, join(frames, "still.png"));
    while (!(await drawnNow())) {
      posterSec -= 1 / CARD_FPS;
      if (posterSec < stillSec - 1.5 || posterSec < 0) throw new Error(`${named.id}: nothing is drawn near the still (${stillSec}s)`);
      await shoot(posterSec, join(frames, "still.png"));
    }

    const video = join(OUT, `${named.id}.mp4`);
    await run("ffmpeg", [
      "-y", "-loglevel", "error", "-framerate", String(CARD_FPS), "-i", join(frames, "%05d.png"),
      "-c:v", "libx264", "-preset", "slow", "-crf", "26", "-pix_fmt", "yuv420p", "-profile:v", "high",
      "-g", String(count), "-movflags", "+faststart", "-an", video,
    ]);
    await run("ffmpeg", ["-y", "-loglevel", "error", "-i", join(frames, "still.png"), "-c:v", "libwebp", "-quality", "82", join(OUT, `${named.id}.webp`)]);
    console.log(`${named.id}: ${count} frames, ${(statSync(video).size / 1024).toFixed(0)} KB clip`);
    return { hash: captionCardSourceHash(named), faces: (faces ?? []) as CaptionCardClipEntry["faces"] };
  } finally {
    rmSync(frames, { recursive: true, force: true });
  }
}

/** Written after every clip, so an interrupted run keeps what it recorded. */
function writeManifest() {
  // Presets that left the catalogue lose their entry.
  for (const id of Object.keys(manifest.cards)) if (!carded.some((named) => named.id === id)) delete manifest.cards[id];
  const sorted = Object.fromEntries(Object.entries(manifest.cards).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(MANIFEST, `${JSON.stringify({ cards: sorted }, null, 2)}\n`);
}

mkdirSync(OUT, { recursive: true });
const queue = [...wanted];
const failures: string[] = [];
try {
  await Promise.all(
    Array.from({ length: Math.min(jobs, queue.length) }, async () => {
      const browser = await launchBrowser();
      try {
        for (let named = queue.shift(); named; named = queue.shift()) {
          try {
            manifest.cards[named.id] = await recordWithRetries(browser, named);
            writeManifest();
          } catch (error) {
            failures.push(`${named.id}: ${(error as Error).message}`);
          }
        }
      } finally {
        browser.close();
      }
    }),
  );
} finally {
  writeManifest();
}
if (failures.length > 0) {
  console.error(`Failed:\n${failures.join("\n")}`);
  process.exit(1);
}
