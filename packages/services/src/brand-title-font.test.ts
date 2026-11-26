import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DEFAULT_CAPTION_PRESET, DEFAULT_TITLE_STYLE, brandTitleSchema } from "@narriflow/validators";
import { BrandFontReferenceError } from "./brand-font-contract";
import { BrandFontService, brandFontService } from "./brand-font.service";
import { BrandTemplateService } from "./brand-template.service";
import { workspaceService } from "./workspace.service";

/** Title-text ticket 08: a brand template title's uploaded font is checked like the caption's, and holds the font against deletion. */

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-000000000002";
const FONT = { kind: "brand_font" as const, id: "4d119c8d-acde-4d95-82a4-0e61210e61db", fingerprint: "a".repeat(64) };
const OTHER = { ...FONT, id: "9d119c8d-acde-4d95-82a4-0e61210e61db" };
const titleWith = (fontAsset: typeof FONT | null) => brandTitleSchema.parse({ style: { ...DEFAULT_TITLE_STYLE, fontAsset } });

function templatePrisma() {
  const rows = new Map<string, Record<string, unknown>>();
  const brandTemplate = {
    async create({ data }: { data: Record<string, unknown> }) {
      const now = new Date("2026-11-27T00:00:00Z");
      const row = { id: `00000000-0000-4000-8000-0000000001${String(rows.size).padStart(2, "0")}`, builtInKey: null, deletedAt: null, createdAt: now, updatedAt: now, ...data };
      rows.set(row.id as string, row);
      return row;
    },
    async findFirst({ where }: { where: { id: string } }) { return rows.get(where.id) ?? null; },
    async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
      const row = { ...rows.get(where.id)!, ...data };
      rows.set(where.id, row);
      return row;
    },
    async count() { return 0; },
  };
  const tx = { brandTemplate, $queryRaw: async () => [] };
  return { ...tx, $transaction: async (body: (client: typeof tx) => Promise<unknown>) => body(tx) };
}

describe("brand template title font", () => {
  let service: BrandTemplateService;
  let actor: ReturnType<typeof spyOn>;
  let assertion: ReturnType<typeof spyOn>;
  beforeEach(() => {
    const prisma = templatePrisma();
    service = new BrandTemplateService();
    (service as unknown as { requirePrisma: () => unknown }).requirePrisma = () => prisma;
    actor = spyOn(workspaceService, "requireActor").mockResolvedValue({ workspaceOwnerUserId: OWNER, pricingTier: "pro" } as never);
    assertion = spyOn(brandFontService, "assertSelection").mockResolvedValue(undefined);
  });
  afterEach(() => {
    actor.mockRestore();
    assertion.mockRestore();
  });

  const checked = () => assertion.mock.calls.map((call: unknown[]) => call[1]).filter(Boolean);

  test("create checks the title's font", async () => {
    await service.create({ actorUserId: OWNER, workspaceId: WORKSPACE }, { name: "N", captionPreset: DEFAULT_CAPTION_PRESET, title: titleWith(FONT) });
    expect(checked()).toEqual([FONT]);
  });

  test("an unusable title font fails the create", async () => {
    assertion.mockImplementation(async (_scope: unknown, reference: unknown) => {
      if (reference) throw new Error("brand_font_not_found");
    });
    await expect(service.create({ actorUserId: OWNER, workspaceId: WORKSPACE }, { name: "N", captionPreset: DEFAULT_CAPTION_PRESET, title: titleWith(FONT) })).rejects.toThrow("brand_font_not_found");
  });

  test("update checks a changed title font, not an unchanged one", async () => {
    const scope = { actorUserId: OWNER, workspaceId: WORKSPACE };
    const created = await service.create(scope, { name: "N", captionPreset: DEFAULT_CAPTION_PRESET, title: titleWith(FONT) });
    assertion.mockClear();
    await service.update(scope, created.id, { title: titleWith(FONT) });
    expect(checked()).toEqual([]);
    await service.update(scope, created.id, { title: titleWith(OTHER) });
    expect(checked()).toEqual([OTHER]);
    await service.update(scope, created.id, { title: titleWith(null) });
    expect(checked()).toEqual([OTHER]);
  });
});

describe("deleting a font a brand template title uses", () => {
  test("the guard looks at the caption style and the title", async () => {
    const wheres: unknown[] = [];
    const tx = {
      brandFont: { findFirst: async () => ({ id: FONT.id, profiles: [] }) },
      sceneTemplate: { findFirst: async () => null },
      brandTemplate: {
        findFirst: async ({ where }: { where: unknown }) => {
          wheres.push(where);
          return { id: "template" };
        },
      },
    };
    const service = new BrandFontService();
    (service as unknown as { requirePrisma: () => unknown }).requirePrisma = () => ({ $transaction: async (body: (client: typeof tx) => Promise<unknown>) => body(tx) });
    const scope = { actorUserId: OWNER, workspaceId: WORKSPACE, workspaceOwnerUserId: OWNER, role: "owner", status: "active", pricingTier: "pro", isPersonalWorkspace: false } as never;
    await expect(service.softDelete(scope, FONT.id, {})).rejects.toBeInstanceOf(BrandFontReferenceError);
    expect(wheres).toEqual([
      {
        deletedAt: null,
        workspaceId: WORKSPACE,
        OR: [
          { captionPreset: { path: ["fontAsset", "id"], equals: FONT.id } },
          { title: { path: ["style", "fontAsset", "id"], equals: FONT.id } },
        ],
      },
    ]);
  });
});
