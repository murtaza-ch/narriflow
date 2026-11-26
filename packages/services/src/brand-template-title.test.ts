import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Prisma } from "@prisma/client";
import { DEFAULT_CAPTION_PRESET, DEFAULT_TITLE_STYLE, brandTemplateSnapshotSchema, brandTitleSchema, type BrandTitle } from "@narriflow/validators";
import { BrandTemplateService, brandTemplateSnapshot } from "./brand-template.service";
import { buildBrandProfileSnapshot, brandAudioSnapshot } from "./brand-profile.service";
import { workspaceService } from "./workspace.service";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const scope = { actorUserId: OWNER, workspaceId: WORKSPACE };

/** The BrandTemplate rows the service reads and writes, with Prisma's JSON null markers resolved as Postgres stores them. */
function fakePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  const writes: Array<Record<string, unknown>> = [];
  const stored = (data: Record<string, unknown>) =>
    Object.fromEntries(Object.entries(data).map(([key, value]) => [key, value === Prisma.DbNull || value === Prisma.JsonNull ? null : value]));
  const brandTemplate = {
    async create({ data }: { data: Record<string, unknown> }) {
      writes.push(data);
      const now = new Date("2026-11-27T00:00:00Z");
      const row = { id: `00000000-0000-4000-8000-0000000001${String(rows.size).padStart(2, "0")}`, builtInKey: null, deletedAt: null, createdAt: now, updatedAt: now, ...stored(data) };
      rows.set(row.id as string, row);
      return row;
    },
    async findFirst({ where }: { where: { id: string } }) { return rows.get(where.id) ?? null; },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      writes.push(data);
      const row = { ...rows.get(where.id)!, ...stored(data) };
      rows.set(where.id, row);
      return row;
    },
    async count() { return 0; },
  };
  const tx = { brandTemplate, $queryRaw: async () => [] };
  return { rows, writes, client: { ...tx, $transaction: async (body: (client: typeof tx) => Promise<unknown>) => body(tx) } };
}

const input = { name: "Northstar", captionPreset: DEFAULT_CAPTION_PRESET };
const brandTitle: BrandTitle = brandTitleSchema.parse({ enabled: false, durationSec: 9, positionY: 22, style: { ...DEFAULT_TITLE_STYLE, color: "#FF0000" } });

describe("brand template title persistence", () => {
  let prisma: ReturnType<typeof fakePrisma>;
  let service: BrandTemplateService;
  let actor: ReturnType<typeof spyOn>;
  beforeEach(() => {
    prisma = fakePrisma();
    service = new BrandTemplateService();
    (service as unknown as { requirePrisma: () => unknown }).requirePrisma = () => prisma.client;
    actor = spyOn(workspaceService, "requireActor").mockResolvedValue({ workspaceOwnerUserId: OWNER, pricingTier: "pro" } as never);
  });
  afterEach(() => actor.mockRestore());

  test("create, update, summary, snapshot and duplicate carry the title", async () => {
    const created = await service.create(scope, { ...input, title: brandTitle });
    expect(created.title).toEqual(brandTitle);
    const row = prisma.rows.get(created.id)!;
    expect(brandTemplateSnapshot(row as never).title).toEqual(brandTitle);

    const restyled = brandTitleSchema.parse({ ...brandTitle, enabled: true, durationSec: null });
    const updated = await service.update(scope, created.id, { title: restyled });
    expect(updated.title).toEqual(restyled);
    // An update that leaves the title out keeps it.
    expect((await service.update(scope, created.id, { name: "Renamed" })).title).toEqual(restyled);

    const copy = await service.duplicate(scope, created.id);
    expect(copy.title).toEqual(restyled);
    expect(service.buildSnapshot(prisma.rows.get(copy.id) as never).title).toEqual(restyled);
  });

  test("null is the built-in default, written as SQL NULL", async () => {
    const created = await service.create(scope, input);
    expect(created.title).toBeNull();
    expect(prisma.writes[0]!.title).toBe(Prisma.DbNull);
    await service.update(scope, created.id, { title: brandTitle });
    const cleared = await service.update(scope, created.id, { title: null });
    expect(cleared.title).toBeNull();
    expect(prisma.writes.at(-1)!.title).toBe(Prisma.DbNull);
    expect((await service.duplicate(scope, created.id)).title).toBeNull();
    expect(prisma.writes.at(-1)!.title).toBe(Prisma.DbNull);
  });

  test("a profile's style and a project's snapshot are the same JSON, title included", async () => {
    const created = await service.create(scope, { ...input, title: brandTitle });
    const row = prisma.rows.get(created.id)! as never;
    const profile = { id: "4d119c8d-acde-4d95-82a4-0e61210e61db", name: "N", revision: 1, visualIdentity: {}, voiceGuidance: {}, approvalRule: "none" };
    const style = buildBrandProfileSnapshot(profile, row, brandAudioSnapshot([])).style;
    expect(JSON.stringify(style)).toBe(JSON.stringify(service.buildSnapshot(row)));
    // A stored snapshot read back parses to the same JSON (campaign comparisons stringify parsed snapshots).
    expect(JSON.stringify(brandTemplateSnapshotSchema.parse(JSON.parse(JSON.stringify(style))))).toBe(JSON.stringify(style));
  });
});
