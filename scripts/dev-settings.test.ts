import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serializeDevelopmentSettings } from "../apps/api/scripts/dev-settings";
import { createProgressTicketCodec, loadProgressTicketKeys } from "../packages/services/src/progress-ticket";

test("local signing keys survive Bun loading and Wrangler secret loading before issuing progress tickets", async () => {
  const directory = await mkdtemp(join(tmpdir(), "narriflow-dev-settings-test-"));
  let proxy: { env: Record<string, unknown>; dispose(): Promise<void> } | undefined;
  try {
    const keyring = JSON.stringify({ local: Buffer.alloc(32, 7).toString("base64url") });
    const source = join(directory, "source.env");
    await writeFile(source, `PROGRESS_CONNECT_KEY_ID=local\nPROGRESS_CONNECT_KEYS_JSON='${keyring}'\nLITERAL='keep $HOME and \\n literal'\n`, { mode: 0o600 });
    const child = Bun.spawn([process.execPath, "--env-file=" + source, "-e", 'console.log(JSON.stringify(Object.fromEntries(["PROGRESS_CONNECT_KEY_ID","PROGRESS_CONNECT_KEYS_JSON","LITERAL"].map(k=>[k,process.env[k]]))))'], { stdout: "pipe", stderr: "pipe", env: { PATH: process.env.PATH } });
    const settings = JSON.parse(await new Response(child.stdout).text()) as Record<string, string>;
    Object.assign(settings, { SINGLE_QUOTE: "it's literal", BOTH_QUOTES: "both ' and \" quotes", BACKSLASH: "ends in \\", NEWLINE: "first\nsecond" });
    expect(await child.exited).toBe(0);
    await writeFile(join(directory, ".dev.vars"), serializeDevelopmentSettings(settings), { mode: 0o600 });
    await writeFile(join(directory, "worker.js"), "export default {fetch(){return new Response('ok')}}");
    const configPath = join(directory, "wrangler.json");
    await writeFile(configPath, JSON.stringify({ name: "development-settings-test", main: "worker.js", compatibility_date: "2026-10-30" }));
    const require = createRequire(new URL("../apps/api/package.json", import.meta.url));
    const { getPlatformProxy } = await import(require.resolve("wrangler"));
    proxy = await getPlatformProxy({ configPath, persist: false });
    expect(proxy!.env.PROGRESS_CONNECT_KEYS_JSON).toBe(keyring);
    expect(proxy!.env.LITERAL).toBe(settings.LITERAL);
    for (const [name, value] of Object.entries(settings)) expect(proxy!.env[name]).toBe(value);
    const codec = createProgressTicketCodec(loadProgressTicketKeys(proxy!.env as Record<string, string>));
    const now = Date.now();
    const scope = { actorUserId: "actor", workspaceId: "workspace", projectId: "50000000-0000-4000-8000-000000000001", origin: "http://localhost:3000", audience: "http://localhost:4000/api/progress" };
    const ticket = await codec.issue(scope, now);
    expect((await codec.verify(ticket, { origin: scope.origin, audience: scope.audience, nowMs: now })).projectId).toBe(scope.projectId);
  } finally {
    await proxy?.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

test("unrepresentable quote sequences and carriage returns fail without changing secret bytes", () => {
  for (const value of [String.fromCharCode(39, 34, 92, 39), "first\rsecond"]) {
    expect(() => serializeDevelopmentSettings({ TEST: value })).toThrow("Cannot encode development setting TEST as dotenv");
  }
});
