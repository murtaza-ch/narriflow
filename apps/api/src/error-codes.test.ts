import { describe, expect, test } from "bun:test";
import { readdir } from "node:fs/promises";

const domains = new URL("./domains/", import.meta.url);

async function routeModules(): Promise<URL[]> {
  const found: URL[] = [];
  for (const entry of await readdir(domains, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const file of ["routes.ts", "webhooks.ts"]) {
      const url = new URL(`${entry.name}/${file}`, domains);
      if (await Bun.file(url).exists()) found.push(url);
    }
  }
  return found;
}

describe("domain route modules", () => {
  test("literal error codes are stable snake_case", async () => {
    const codes: string[] = [];
    for (const module of await routeModules()) {
      const source = await Bun.file(module).text();
      codes.push(...[...source.matchAll(/error:\s*["']([^"']+)["']/g)].map(([, code]) => code as string));
    }
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) expect(code).toMatch(/^[a-z][a-z0-9]*(?:_[a-z0-9]+)*$/);
  });

  test("handlers never read the actor outside the admission helpers", async () => {
    const forbidden = ["getCurrentAppUser", "authenticatedHonoActor", "authenticatedHonoInput", "next/headers", "@clerk/nextjs"];
    for (const module of await routeModules()) {
      const source = await Bun.file(module).text();
      for (const value of forbidden) expect(source).not.toContain(value);
    }
  });
});
