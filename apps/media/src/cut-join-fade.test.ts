import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildClipCutPlan } from "@narriflow/validators";
import { buildCutConcatFilter, CUT_JOIN_FADE_SEC } from "./composition-ffmpeg-adapter";

const RATE = 48_000;

/** Renders the cut graph's audio for a 2 s 440 Hz tone and returns its samples. */
async function renderCut(deleted: { startSec: number; endSec: number }[]) {
  const dir = await mkdtemp(join(tmpdir(), "cut-join-"));
  try {
    const plan = buildClipCutPlan(deleted, { startSec: 0, endSec: 2 });
    const cut = buildCutConcatFilter({ cutPlan: plan, clipStartSec: 0, includeVideo: false, includeAudio: true })!;
    const graph = cut.filterParts.join(";");
    const proc = Bun.spawnSync(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", `sine=f=440:d=2:sample_rate=${RATE},volume=0.8`,
      "-filter_complex", graph, "-map", cut.audioLabel!, "-ac", "1", "-f", "f32le", "-"], { maxBuffer: 1 << 26 });
    expect(proc.exitCode).toBe(0);
    const bytes = proc.stdout;
    return { plan, graph, samples: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function maxStepNear(samples: Float32Array, atSec: number) {
  const center = Math.round(atSec * RATE);
  let max = 0;
  for (let i = Math.max(1, center - 96); i < Math.min(samples.length, center + 96); i++) max = Math.max(max, Math.abs(samples[i]! - samples[i - 1]!));
  return max;
}

describe("audio cut joins", () => {
  test("a join cut mid-waveform has no step and the duration is exact", async () => {
    // 0.3013 s and 0.6 s land at very different phases of a 440 Hz wave.
    const { plan, graph, samples } = await renderCut([{ startSec: 0.3013, endSec: 0.6 }]);
    expect(graph).toContain(`afade=t=out:st=${(0.301 - CUT_JOIN_FADE_SEC).toFixed(6)}`);
    expect(graph).toContain("afade=t=in:st=0");
    expect(samples.length / RATE).toBeCloseTo(plan.editedDurationSec, 2);
    // The tone's own largest sample-to-sample step, measured well away from the join.
    const toneStep = maxStepNear(samples, 1.0);
    expect(toneStep).toBeGreaterThan(0);
    expect(maxStepNear(samples, 0.301)).toBeLessThanOrEqual(toneStep * 1.05);
  });

  test("the clip's own start and end are not faded, and an uncut clip has no fades", async () => {
    const { samples } = await renderCut([{ startSec: 0.9, endSec: 1.1 }]);
    // The first and last 10 ms reach the tone's full amplitude: no fade at the clip edges.
    const peak = Math.max(...samples.slice(RATE / 2, RATE).map(Math.abs));
    expect(Math.max(...samples.slice(0, RATE / 100).map(Math.abs))).toBeGreaterThan(peak * 0.95);
    expect(Math.max(...samples.slice(samples.length - RATE / 100).map(Math.abs))).toBeGreaterThan(peak * 0.95);
    expect(buildCutConcatFilter({ cutPlan: buildClipCutPlan([], { startSec: 0, endSec: 2 }), clipStartSec: 0, includeVideo: false, includeAudio: true })).toBeNull();
  });

  test("a segment shorter than two fades fades over half its length", async () => {
    const { graph } = await renderCut([{ startSec: 0.5, endSec: 0.6 }, { startSec: 0.608, endSec: 1 }]);
    // The kept 0.6-0.608 piece is under MIN_KEPT_SEGMENT_SEC and dropped by the plan; no fade exceeds a segment.
    for (const match of graph.matchAll(/afade=t=(?:in|out):st=([\d.]+):d=([\d.]+)/g)) expect(Number(match[2])).toBeLessThanOrEqual(CUT_JOIN_FADE_SEC);
  });
});
