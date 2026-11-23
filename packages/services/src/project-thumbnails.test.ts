import { expect, mock, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { readProjectThumbnails } from "./project-thumbnails";

const project = { id: "60000000-0000-4000-8000-000000000001", sourceType: "upload", sourceStorageKey: "execution/source", expiresAt: null as string | null };
function database(rows: { projectId: string; role: string; storageKey: string }[]) {
  return { $queryRaw: mock(async () => rows) } as unknown as Pick<PrismaClient, "$queryRaw">;
}
test("unready uploads and other providers need no thumbnail read or signing", async () => {
  const db = database([]), sign = mock(async () => "https://storage.example/signed");
  expect((await readProjectThumbnails(db, "workspace", [{ ...project, sourceStorageKey: null }, { ...project, sourceType: "youtube" }], sign)).size).toBe(0);
  expect(db.$queryRaw).not.toHaveBeenCalled(); expect(sign).not.toHaveBeenCalled();
});
test("saved images get private, retention-bounded access, including a partially available pair", async () => {
  const db = database([{ projectId: project.id, role: "source_thumbnail_large", storageKey: "execution/large" }]);
  const sign = mock(async (input: { key: string; expiresIn?: number; cacheControl?: string }) => {
    expect(input.expiresIn).toBeGreaterThan(0); expect(input.expiresIn!).toBeLessThanOrEqual(120);
    expect(input.cacheControl).toMatch(/^private, max-age=\d+$/);
    return "https://storage.example/large?signature=example";
  });
  const result = await readProjectThumbnails(db, "60000000-0000-4000-8000-000000000002", [{ ...project, expiresAt: new Date(Date.now() + 120_000).toISOString() }], sign);
  expect(result.get(project.id)).toMatchObject({ small: null, large: "https://storage.example/large?signature=example" });
  expect(JSON.stringify([...result])).not.toContain("execution/large");
});
test("an expired project receives no grant", async () => {
  const db = database([{ projectId: project.id, role: "source_thumbnail_small", storageKey: "execution/small" }]);
  const sign = mock(async () => "https://storage.example/small");
  expect((await readProjectThumbnails(db, "workspace", [{ ...project, expiresAt: new Date(Date.now() - 1000).toISOString() }], sign)).size).toBe(0);
  expect(sign).not.toHaveBeenCalled();
});
