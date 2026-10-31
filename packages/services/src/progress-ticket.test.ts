import { expect, test } from "bun:test";
import { createProgressTicketCodec } from "./progress-ticket";

const scope = { actorUserId: "actor", workspaceId: "workspace", projectId: "50000000-0000-4000-8000-000000000001", origin: "https://web.narriflow.test", audience: "https://api.narriflow.test" };
const keys = { activeKeyId: "gate", keys: { gate: new Uint8Array(32).fill(7) } };

test("a connect ticket is bound to audience, origin and its bounded authorization lifetime", async () => {
  const codec = createProgressTicketCodec(keys);
  const ticket = await codec.issue(scope, 1_000);
  expect((await codec.verify(ticket, { audience: scope.audience, origin: scope.origin, nowMs: 2_000 })).projectId).toBe(scope.projectId);
  await expect(codec.verify(ticket, { audience: scope.audience, origin: "https://wrong.test", nowMs: 2_000 })).rejects.toThrow("invalid_progress_ticket");
  await expect(codec.verify(ticket, { audience: "https://wrong.test", origin: scope.origin, nowMs: 2_000 })).rejects.toThrow("invalid_progress_ticket");
  await expect(codec.verify(ticket, { audience: scope.audience, origin: scope.origin, nowMs: 31_000 })).rejects.toThrow("invalid_progress_ticket");
});

test("changed content, unknown keys and future authorization fail before scope is returned", async () => {
  const codec = createProgressTicketCodec(keys);
  const ticket = await codec.issue(scope, 10_000);
  const parts = ticket.split(".");
  parts[2] = `${parts[2]?.slice(0, -1)}A`;
  await expect(codec.verify(parts.join("."), { audience: scope.audience, origin: scope.origin, nowMs: 11_000 })).rejects.toThrow("invalid_progress_ticket");
  await expect(createProgressTicketCodec({ activeKeyId: "other", keys: { other: new Uint8Array(32).fill(9) } }).verify(ticket,
    { audience: scope.audience, origin: scope.origin, nowMs: 11_000 })).rejects.toThrow("invalid_progress_ticket");
  await expect(codec.verify(ticket, { audience: scope.audience, origin: scope.origin, nowMs: 1_000 })).rejects.toThrow("invalid_progress_ticket");
});
