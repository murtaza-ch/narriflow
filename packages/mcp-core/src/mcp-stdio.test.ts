import { expect, test } from "bun:test";
import { OAuthError, OAuthErrorCode, type JSONRPCMessage, type Transport } from "@modelcontextprotocol/server";
import { createAuthenticatedStdioTransport } from "./mcp-stdio";

test("stdio stops requests after revocation and refreshes scopes without restarting", async () => {
  let active = true;
  let scopes = ["projects:read"];
  const sent: JSONRPCMessage[] = [];
  const calls: string[][] = [];
  const wire: Transport = { start: async () => {}, close: async () => {}, send: async (message) => { sent.push(message); } };
  const checked = createAuthenticatedStdioTransport({ wire, diagnostic: () => {},
    authenticate: async () => {
      if (!active) throw new OAuthError(OAuthErrorCode.InvalidToken, "revoked");
      return { kind: "api_key", userId: "user", clientId: "key", apiKeyId: "key", workspaceId: "workspace", scopes };
    }, checkRateLimit: async () => ({ allowed: true, remaining: 299, limit: 300, availability: "available" }) });
  checked.transport.onmessage = () => { void checked.authenticatePrincipal().then((principal) => calls.push(principal.scopes)); };
  await checked.transport.start();
  const invoke = async (id: number) => { wire.onmessage?.({ jsonrpc: "2.0", id, method: "tools/list", params: {} }); await Bun.sleep(0); };
  await invoke(1);
  scopes = ["projects:read", "processing:write"];
  await invoke(2);
  active = false;
  await invoke(3);
  expect(calls).toEqual([["projects:read"], ["projects:read", "processing:write"]]);
  expect(sent).toEqual([{ jsonrpc: "2.0", id: 3, error: { code: -32001, message: "Credential is invalid or revoked", data: { error: "invalid_token" } } }]);
});

test("stdio keeps concurrent request admission isolated and pauses only new writes in an outage", async () => {
  let sequence = 0;
  const wire: Transport = { start: async () => {}, close: async () => {}, send: async () => {} };
  const checked = createAuthenticatedStdioTransport({ wire, diagnostic: () => {}, authenticate: async () => ({
    kind: "oauth", userId: `user-${++sequence}`, clientId: "client", scopes: ["projects:read"],
  }), checkRateLimit: async () => ({ allowed: true, remaining: 300, limit: 300, availability: "unavailable" }) });
  const observed: string[] = [];
  checked.transport.onmessage = () => { void (async () => {
    const principal = await checked.authenticatePrincipal();
    await Bun.sleep(0);
    expect((await checked.authenticatePrincipal()).userId).toBe(principal.userId);
    expect(() => checked.assertNewMutationAllowed()).toThrow(expect.objectContaining({ kind: "unavailable" }));
    observed.push(principal.userId);
  })(); };
  await checked.transport.start();
  wire.onmessage?.({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  wire.onmessage?.({ jsonrpc: "2.0", id: 2, method: "tools/list" });
  await Bun.sleep(5);
  expect(observed).toEqual(["user-1", "user-2"]);
});
