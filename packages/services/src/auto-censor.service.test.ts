import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { DEFAULT_CENSOR_WORD_LIST } from "@narriflow/validators";
import { autoCensorService } from "./auto-censor.service";
import type { BrandActorScope } from "./brand-ownership";

const WORKSPACE = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const CLIP = "00000000-0000-4000-8000-000000000003";

function scope(role: BrandActorScope["role"], pricingTier = "creator"): BrandActorScope {
  return {
    actorUserId: "00000000-0000-4000-8000-000000000004",
    workspaceId: WORKSPACE,
    workspaceOwnerUserId: "00000000-0000-4000-8000-000000000004",
    role,
    status: "active",
    pricingTier,
    isPersonalWorkspace: false,
  };
}

let storedProjectTerms: unknown = ["launch*"];
let workspaceRow: { censorWords: string[]; censorWordsCustomized: boolean } | null;
const updates: unknown[] = [];
const events: unknown[] = [];
const fakePrisma = {
  workspace: {
    findUnique: async () => workspaceRow,
    update: async ({ data }: { data: { censorWords: string[]; censorWordsCustomized: boolean } }) => {
      updates.push(data);
      workspaceRow = { ...data };
      return workspaceRow;
    },
  },
  project: {
    findFirst: async () => ({ languageCode: "en", censorTerms: storedProjectTerms, brandProfile: null }),
  },
  clip: {
    findFirst: async ({ where }: { where: { id: string; projectId: string } }) =>
      where.projectId === PROJECT && where.id === CLIP ? { id: CLIP } : null,
  },
  projectAnalyticsEvent: {
    create: async ({ data }: { data: unknown }) => {
      events.push(data);
    },
  },
} as unknown as PrismaClient;

const globals = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };
const previousPrisma = globals.narriflowPrismaClient;
const previousDatabaseUrl = process.env.DATABASE_URL;
beforeAll(() => {
  globals.narriflowPrismaClient = fakePrisma;
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://unused.test/db";
});
afterAll(() => {
  globals.narriflowPrismaClient = previousPrisma;
  if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
  else process.env.DATABASE_URL = previousDatabaseUrl;
});

describe("Workspace censored words", () => {
  test("equal the defaults until edited, then replace them entirely and reset back", async () => {
    workspaceRow = { censorWords: [], censorWordsCustomized: false };
    expect(await autoCensorService.getWorkspaceWords(scope("viewer"))).toEqual({
      words: [...DEFAULT_CENSOR_WORD_LIST], customized: false,
    });

    const saved = await autoCensorService.replaceWorkspaceWords(scope("admin"), [" Heck ", "heck", "darn*"]);
    expect(saved).toEqual({ words: ["Heck", "darn*"], customized: true });
    expect(updates.at(-1)).toEqual({ censorWords: ["Heck", "darn*"], censorWordsCustomized: true });
    expect(await autoCensorService.getWorkspaceWords(scope("viewer"))).toEqual({
      words: ["Heck", "darn*"], customized: true,
    });

    // Deleting every word is a real, saved choice, not a return to the defaults.
    await autoCensorService.replaceWorkspaceWords(scope("owner"), []);
    expect(await autoCensorService.getWorkspaceWords(scope("viewer"))).toEqual({ words: [], customized: true });

    expect(await autoCensorService.resetWorkspaceWords(scope("owner"))).toEqual({
      words: [...DEFAULT_CENSOR_WORD_LIST], customized: false,
    });
    expect(updates.at(-1)).toEqual({ censorWords: [], censorWordsCustomized: false });
  });

  test("only roles that manage the workspace can change the list", async () => {
    workspaceRow = { censorWords: [], censorWordsCustomized: false };
    const before = updates.length;
    for (const role of ["editor", "viewer"] as const) {
      await expect(autoCensorService.replaceWorkspaceWords(scope(role), ["heck"]))
        .rejects.toMatchObject({ code: "auto_censor_forbidden" });
      await expect(autoCensorService.resetWorkspaceWords(scope(role)))
        .rejects.toMatchObject({ code: "auto_censor_forbidden" });
    }
    expect(updates.length).toBe(before);
  });

  test("reject lists that break the limits", async () => {
    await expect(autoCensorService.replaceWorkspaceWords(scope("owner"), ["f*ck"])).rejects.toThrow();
    await expect(
      autoCensorService.replaceWorkspaceWords(scope("owner"), Array.from({ length: 201 }, (_, index) => `w${index}x`)),
    ).rejects.toThrow();
  });

  test("the Studio policy carries the workspace list, project terms and who may edit the list", async () => {
    workspaceRow = { censorWords: ["heck"], censorWordsCustomized: true };
    const admin = await autoCensorService.getPolicy(scope("admin"), PROJECT);
    expect(admin).toMatchObject({
      workspaceTerms: ["heck"],
      workspaceTermsCustomized: true,
      projectTerms: ["launch*"],
      canEditWorkspaceTerms: true,
      canApply: true,
    });
    const editor = await autoCensorService.getPolicy(scope("editor"), PROJECT);
    expect(editor.canEditWorkspaceTerms).toBe(false);
    expect(editor.canApply).toBe(true);
    expect((await autoCensorService.getPolicy(scope("editor", "free"), PROJECT)).canApply).toBe(false);
  });

  test("a stored project term the rules now reject is skipped, not fatal", async () => {
    workspaceRow = { censorWords: [], censorWordsCustomized: false };
    storedProjectTerms = ["fu*ck", "ab*", "launch*", "Launch*", 42, "x".repeat(81), " ok word "];
    try {
      const policy = await autoCensorService.getPolicy(scope("editor"), PROJECT);
      expect(policy.projectTerms).toEqual(["launch*", "ok word"]);
      storedProjectTerms = "not a list";
      expect((await autoCensorService.getPolicy(scope("editor"), PROJECT)).projectTerms).toEqual([]);
    } finally {
      storedProjectTerms = ["launch*"];
    }
    // Writes stay strict.
    await expect(autoCensorService.replaceProjectTerms(scope("editor"), PROJECT, ["fu*ck"])).rejects.toThrow();
  });
});

describe("Auto Censor analytics", () => {
  test("records an event for a clip of the Project and for any role that can view", async () => {
    const before = events.length;
    await autoCensorService.recordEvent(scope("viewer"), PROJECT, CLIP, { type: "auto_censor_scan_started" });
    expect(events.length).toBe(before + 1);
    expect(events.at(-1)).toMatchObject({ projectId: PROJECT, clipId: CLIP });
  });

  test("refuses a clip that is not in the Project without recording anything", async () => {
    const before = events.length;
    await expect(
      autoCensorService.recordEvent(scope("editor"), PROJECT, "00000000-0000-4000-8000-0000000000ff", {
        type: "auto_censor_scan_started",
      }),
    ).rejects.toMatchObject({ code: "auto_censor_forbidden" });
    expect(events.length).toBe(before);
  });
});
