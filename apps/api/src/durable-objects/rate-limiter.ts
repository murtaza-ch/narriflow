import { DurableObject } from "cloudflare:workers";
import type { RateLimitResult } from "@narriflow/services/rate-limit";

export interface RateLimitCommand {
  limit: number;
  windowSeconds: number;
  consume: boolean;
}

/** One object per hashed key and window length. Its SQLite row is the complete
 * counter; no process-local counter or Postgres query participates. */
export class RateLimiter extends DurableObject<Record<string, unknown>> {
  constructor(ctx: DurableObjectState, env: Record<string, unknown>) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS rate_window (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      window_start_ms INTEGER NOT NULL,
      used_count INTEGER NOT NULL CHECK (used_count >= 0),
      expires_at_ms INTEGER NOT NULL
    )`);
  }

  async check(input: RateLimitCommand): Promise<RateLimitResult> {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 1_000_000 ||
      !Number.isSafeInteger(input.windowSeconds) || input.windowSeconds < 1 || input.windowSeconds > 86_400 ||
      typeof input.consume !== "boolean") throw new Error("Invalid rate limit command");
    const now = Date.now();
    const windowMs = input.windowSeconds * 1_000;
    const windowStart = Math.floor(now / windowMs) * windowMs;
    const { used, setAlarm } = this.ctx.storage.transactionSync(() => {
      const previous = this.ctx.storage.sql.exec<{ window_start_ms: number; used_count: number }>(
        "SELECT window_start_ms, used_count FROM rate_window WHERE id = 1",
      ).toArray()[0];
      const current = previous?.window_start_ms === windowStart ? previous.used_count : 0;
      if (!input.consume) return { used: current, setAlarm: false };
      const used = Math.min(1_000_001, current + 1);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO rate_window (id, window_start_ms, used_count, expires_at_ms) VALUES (1, ?, ?, ?)",
        windowStart, used, windowStart + windowMs,
      );
      return { used, setAlarm: previous?.window_start_ms !== windowStart };
    });
    if (setAlarm) await this.ctx.storage.setAlarm(windowStart + windowMs);
    return {
      availability: "available",
      allowed: input.consume ? used <= input.limit : used < input.limit,
      remaining: Math.max(0, input.limit - used),
      limit: input.limit,
    };
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("DELETE FROM rate_window WHERE expires_at_ms <= ?", Date.now());
  }
}
