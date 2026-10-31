import { readFileSync } from "node:fs";
export interface RenderDiagnostic {
  level: "info" | "error";
  message: string;
  context?: Record<string, unknown>;
}

interface ProductionRenderDiagnosticDependencies {
  now: () => Date;
  write: (line: string) => void;
}

export class ProductionRenderDiagnosticAdapter {
  readonly #dependencies: ProductionRenderDiagnosticDependencies;

  constructor(
    dependencies: ProductionRenderDiagnosticDependencies = {
      now: () => new Date(),
      write: (line) => console.warn(line),
    },
  ) {
    this.#dependencies = dependencies;
  }

  readonly diagnose = (diagnostic: RenderDiagnostic): void => {
    this.#dependencies.write(
      JSON.stringify({
        ...(redactRenderDiagnostic(diagnostic.context) as Record<string, unknown>),
        level: diagnostic.level,
        message: diagnostic.message,
        ts: this.#dependencies.now().toISOString(),
      }),
    );
  };
}

export const productionRenderDiagnosticAdapter =
  new ProductionRenderDiagnosticAdapter();

export type RenderPhase = "presign" | "probe" | "download" | "asset_validation" | "evidence_read" | "analysis" | "compose" | "encode" | "validate" | "upload" | "drain" | "persistence" | "cleanup";
const privateField = /(?:authorization|password|secret|credential|apiKey|accessKey|accessToken|refreshToken|signature|^token$|signedUrl|captionText|transcript|stderr|rawText|commandArgs|parseErrors|^(?:message|error|text|caption|captions|glyph|emoji)$)/i;
/** Diagnostics must not become a second store of source URLs or user text. */
export function redactRenderDiagnostic(value: unknown, key = ""): unknown {
  if (privateField.test(key)) return "[redacted]";
  if (typeof value === "string") return value.replace(/https?:\/\/[^\s"'<>]+/gi, "[redacted-url]").replace(/Bearer\s+\S+/gi, "Bearer [redacted]").slice(0, 1000);
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redactRenderDiagnostic(v, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactRenderDiagnostic(v, k)]));
  return value;
}

/** One execution, one summary. Phase durations sum operations, including
 * retries; overlap means their sum need not equal attempt wall time. */
export class RenderAttemptTelemetry {
  readonly phaseMs: Record<RenderPhase, number> = Object.fromEntries(["presign", "probe", "download", "asset_validation", "evidence_read", "analysis", "compose", "encode", "validate", "upload", "drain", "persistence", "cleanup"].map((p) => [p, 0])) as Record<RenderPhase, number>;
  readonly phaseOperations: Partial<Record<RenderPhase, number>> = {};
  readonly counts = { retryable: 0, permanent: 0, executor: 0, deferral: 0, fallback: 0, glyphOmission: 0, detectorExecutions: 0 };
  constructor(readonly emit: (event: RenderDiagnostic) => void, readonly now: () => number = () => performance.now()) {}
  private safeEmit(event: RenderDiagnostic): void { try { this.emit(event); } catch { /* Telemetry never owns settlement. */ } }
  record(event: RenderDiagnostic): void {
    const c = event.context ?? {};
    if (event.message === "clip_render_variant_failed") {
      if (c.disposition === "permanent") this.counts.permanent++;
      else this.counts.retryable++;
    }
    if (c.disposition === "degraded" || event.message === "framing_degraded" || event.message === "clip_render_optional_asset_fallback") this.counts.fallback++;
    if (event.message === "clip_render_glyph_omissions") this.counts.glyphOmission += Number(c.count ?? 0);
  }
  measure<T>(phase: RenderPhase, operation: string, work: () => T, context: Record<string, unknown> = {}): T {
    const startedAtMs = this.now();
    if (phase === "analysis" && operation.startsWith("detect")) this.counts.detectorExecutions++;
    const end = (ok: boolean) => {
      const endedAtMs = this.now();
      const elapsedMs = Math.max(0, endedAtMs - startedAtMs);
      this.phaseMs[phase] += elapsedMs;
      this.phaseOperations[phase] = (this.phaseOperations[phase] ?? 0) + 1;
      this.safeEmit({ level: ok ? "info" : "error", message: "clip_render_phase", context: { ...context, phase, operation, startedAtMs, endedAtMs, elapsedMs, startedAt: new Date(Date.now() - elapsedMs).toISOString(), endedAt: new Date().toISOString(), ok } });
    };
    try {
      const result = work();
      if (result instanceof Promise) return result.then((v) => { end(true); return v; }, (e: unknown) => { end(false); throw e; }) as T;
      end(true);
      return result;
    } catch (error) { end(false); throw error; }
  }
  wrap<T extends object>(port: T, phases: Partial<Record<keyof T, RenderPhase>>): T {
    return new Proxy(port, { get: (target, key) => {
      const method = Reflect.get(target, key);
      const phase = phases[key as keyof T];
      return typeof method === "function" && phase ? (...args: unknown[]) => this.measure(phase, String(key), () => Reflect.apply(method, target, args),
        phase === "persistence" && typeof args[1] === "string" ? { clipRenderId: args[1] } : {}) : method;
    } });
  }
  finish(context: Record<string, unknown>): void {
    this.safeEmit({ level: "info", message: "clip_render_attempt_metrics", context: { ...context, phaseMs: this.phaseMs, phaseOperations: this.phaseOperations, counts: this.counts } });
  }
}

/** Process RSS and cgroup page cache are different measurements. */
export function renderReplicaResources(): Record<string, unknown> {
  const read = (path: string): string | null => { try { return readFileSync(path, "utf8").trim(); } catch { return null; } };
  const numeric = (path: string): number | null => { const value = read(path); return value !== null && /^\d+$/.test(value) ? Number(value) : null; };
  const pageCache = read("/sys/fs/cgroup/memory.stat")?.match(/^file (\d+)$/m)?.[1];
  const cpu = read("/sys/fs/cgroup/cpu.max")?.split(" ");
  return { workerRssBytes: process.memoryUsage().rss, cgroupCurrentBytes: numeric("/sys/fs/cgroup/memory.current"), cgroupPeakBytes: numeric("/sys/fs/cgroup/memory.peak"), cgroupPageCacheBytes: pageCache ? Number(pageCache) : null, cpuQuotaCores: cpu && cpu[0] !== "max" ? Number(cpu[0]) / Number(cpu[1]) : null, activeChildCount: read(`/proc/self/task/${process.pid}/children`)?.split(/\s+/).filter(Boolean).length ?? null };
}
