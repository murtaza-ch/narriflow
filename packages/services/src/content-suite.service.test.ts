import { describe, expect, test } from "bun:test";
import { reserveContentGeneration, selectTranscriptExcerpt } from "./content-suite.service";

describe("selectTranscriptExcerpt", () => {
  test("returns short transcripts unchanged", () => {
    expect(selectTranscriptExcerpt("short transcript")).toBe(
      "short transcript",
    );
  });

  test("deterministically covers the head, middle, and tail", () => {
    const transcript = [
      `HEAD-${"a".repeat(45_000)}`,
      `MIDDLE-${"b".repeat(45_000)}`,
      "TAIL-",
    ].join("");

    const first = selectTranscriptExcerpt(transcript);
    const second = selectTranscriptExcerpt(transcript);

    expect(first).toBe(second);
    expect(first.length).toBeLessThanOrEqual(48_000);
    expect(first.startsWith("HEAD-")).toBe(true);
    expect(first).toContain("MIDDLE-");
    expect(first).toContain("TAIL-");
    expect(first.endsWith("TAIL-")).toBe(true);
  });
});

/** A stand-in for the table and its lock: the Prisma queries themselves are not run. */
function fakeContentGenerations(rows: Date[]) {
  const counts: Array<{ workspaceId: string; gte: Date }> = [];
  const tx = {
    $queryRaw: async () => [],
    contentGeneration: {
      count: async ({ where }: { where: { workspaceId: string; createdAt: { gte: Date } } }) => {
        counts.push({ workspaceId: where.workspaceId, gte: where.createdAt.gte });
        return rows.filter((createdAt) => createdAt >= where.createdAt.gte).length;
      },
      create: async ({ data }: { data: { createdAt: Date } }) => {
        rows.push(data.createdAt);
        return { id: `generation-${rows.length}` };
      },
    },
  };
  const prisma = { $transaction: async <T>(run: (client: typeof tx) => Promise<T>) => run(tx) };
  return { prisma: prisma as never, rows, counts };
}

describe("reserveContentGeneration", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");

  test("counts only this UTC calendar month and refuses at the plan's ceiling", async () => {
    const lastMonth = new Date("2026-10-31T23:59:59.999Z");
    const world = fakeContentGenerations([lastMonth, ...Array.from({ length: 29 }, () => new Date("2026-11-02T00:00:00.000Z"))]);
    expect(await reserveContentGeneration(world.prisma, "ws", "creator", now)).toBe("generation-31");
    expect(world.counts[0]!.gte.toISOString()).toBe("2026-11-01T00:00:00.000Z");
    const error = await reserveContentGeneration(world.prisma, "ws", "creator", now).catch((reason) => reason);
    expect(error).toMatchObject({
      code: "plan_limit_reached",
      kind: "payment_required",
      details: { limit: "contentGenerations", used: 30, max: 30, currentTier: "creator", requiredTier: "pro" },
    });
    expect(world.rows).toHaveLength(31);
  });

  test("the allowance renews on the first of the month, and the top plan offers no higher tier", async () => {
    const world = fakeContentGenerations(Array.from({ length: 30 }, () => new Date("2026-10-15T00:00:00.000Z")));
    await expect(reserveContentGeneration(world.prisma, "ws", "creator", now)).resolves.toBeTruthy();
    const full = fakeContentGenerations(Array.from({ length: 180 }, () => new Date("2026-11-03T00:00:00.000Z")));
    const error = await reserveContentGeneration(full.prisma, "ws", "business", now).catch((reason) => reason);
    expect(error.details).toMatchObject({ limit: "contentGenerations", max: 180, requiredTier: null });
  });
});
