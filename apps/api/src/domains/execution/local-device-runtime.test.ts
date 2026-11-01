import { afterEach, expect, spyOn, test } from "bun:test";
import { createDatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { createLocalFetchDeviceCodec, LOCAL_FETCH_SESSION_MS } from "@narriflow/services/local-fetch-device";
import { withServiceEnvironment } from "@narriflow/services/runtime-environment";
import { workspaceService } from "@narriflow/services/workspace.service";
import { localFetchDeviceClaimsSchema, localFetchDeviceConfigurationSchema } from "@narriflow/validators/api/local-fetch";
import type { ActorScope } from "../../http/request-policy";
import type { ApiWorkerBindings } from "../../worker-bindings";
import { issueLocalFetchDevice } from "./local-device-runtime";

const actor: ActorScope = {
  actorUserId: crypto.randomUUID(), workspaceId: crypto.randomUUID(),
  workspaceName: "Owned device workspace", workspaceOwnerUserId: crypto.randomUUID(),
  role: "owner", status: "active", pricingTier: "business", isPersonalWorkspace: false,
  workspaceSelectionChanged: false,
};
const origin = "https://api.narriflow.test", rootKey = new Uint8Array(32).fill(7);
const environment = {
  APP_ENV: "development", YOUTUBE_FETCH_MODE: "local", API_ORIGIN: origin,
  LOCAL_FETCH_WORKSPACE_IDS_JSON: JSON.stringify([actor.workspaceId]), DEV_DEVICE_KEY_ID: "owned-device",
  DEV_DEVICE_KEYS_JSON: JSON.stringify({ "owned-device": Buffer.from(rootKey).toString("base64") }),
  MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT: "a".repeat(64),
};
let authorize: ReturnType<typeof spyOn<typeof workspaceService, "requireActor">>;
afterEach(() => authorize?.mockRestore());

function fixture(overrides: Record<string, string> = {}) {
  let clients = 0;
  const registered: unknown[] = [];
  authorize = spyOn(workspaceService, "requireActor").mockResolvedValue({} as never);
  const epochRead = spyOn({ read: async (_input: unknown) => ({ epoch: 10 }) }, "read");
  const bindings = { LOCAL_FETCH_MAILBOX: { getByName: (workspaceId: string) => {
    expect(workspaceId).toBe(actor.workspaceId);
    return { register: async (claims: unknown) => { registered.push(claims); } };
  } } } as unknown as ApiWorkerBindings;
  const issue = (scope: ActorScope = actor) => withServiceEnvironment({ ...environment, ...overrides }, () =>
    withDatabaseScope(createDatabaseScope({ createClient: () => {
      clients++;
      return { client: { executionEpoch: { findUniqueOrThrow: epochRead } } as never, dispose: async () => {} };
    } }), () => issueLocalFetchDevice(scope, bindings)));
  return { issue, registered, epochRead, clients: () => clients };
}

test("issuance projects the admitted actor into strict signed device claims", async () => {
  const f = fixture(), before = Date.now();
  const issued = localFetchDeviceConfigurationSchema.parse(await f.issue());
  expect(authorize).toHaveBeenCalledWith(actor.actorUserId, actor.workspaceId, "processing.consume");
  expect(f.epochRead).toHaveBeenCalledWith({ where: { id: 1 } });
  expect(f.clients()).toBe(1);
  expect(f.registered).toHaveLength(1);
  const verified = await createLocalFetchDeviceCodec(new Map([["owned-device", rootKey]])).verify(issued.sessionToken);
  expect(verified.claims).toEqual(f.registered[0]);
  expect(Object.keys(verified.claims).sort()).toEqual([
    "actorUserId", "apiOrigin", "deploymentEpoch", "expiresAt", "issuedAt", "keyId", "sessionId", "version", "workspaceId",
  ]);
  expect(verified.claims).toMatchObject({ actorUserId: actor.actorUserId, workspaceId: actor.workspaceId, deploymentEpoch: 10, apiOrigin: origin, keyId: "owned-device", version: 1 });
  expect(verified.claims.issuedAt).toBeGreaterThanOrEqual(before);
  expect(verified.claims.issuedAt).toBeLessThanOrEqual(Date.now());
  expect(verified.claims.expiresAt - verified.claims.issuedAt).toBe(LOCAL_FETCH_SESSION_MS);
  expect(LOCAL_FETCH_SESSION_MS).toBe(2 * 60 * 60_000);
  expect(issued).toMatchObject({ workspaceId: actor.workspaceId, apiOrigin: origin, expiresAt: verified.claims.expiresAt, keyId: verified.claims.sessionId, toolchainFingerprint: environment.MEDIA_LOCAL_FETCH_TOOLCHAIN_FINGERPRINT });
  expect(Buffer.from(issued.key, "base64url")).toEqual(Buffer.from(verified.key));
  expect(localFetchDeviceClaimsSchema.safeParse({ ...verified.claims, role: actor.role }).success).toBe(false);
  const [payload] = issued.sessionToken.split(".");
  const tampered = { ...verified.claims, workspaceId: crypto.randomUUID() };
  const tamperedPayload = Buffer.from(JSON.stringify(tampered)).toString("base64url");
  expect(tamperedPayload).not.toBe(payload);
  await expect(createLocalFetchDeviceCodec(new Map([["owned-device", rootKey]])).verify(`${tamperedPayload}.${issued.sessionToken.split(".")[1]}`)).rejects.toThrow("local_fetch_session_invalid");
});

test.each([{ APP_ENV: "production" }, { YOUTUBE_FETCH_MODE: "proxy" }, { LOCAL_FETCH_WORKSPACE_IDS_JSON: "[]" }])(
  "issuance refuses a disallowed development environment before authorization or database access: %j",
  async overrides => {
    const f = fixture(overrides);
    await expect(f.issue()).rejects.toThrow("local_fetch_unavailable");
    expect(authorize).not.toHaveBeenCalled(); expect(f.clients()).toBe(0); expect(f.registered).toHaveLength(0);
  },
);

test("issuance refuses a different workspace before authorization or database access", async () => {
  const f = fixture();
  await expect(f.issue({ ...actor, workspaceId: crypto.randomUUID() })).rejects.toThrow("local_fetch_unavailable");
  expect(authorize).not.toHaveBeenCalled(); expect(f.clients()).toBe(0); expect(f.registered).toHaveLength(0);
});

test("workspace authorization failure cannot issue or register a device", async () => {
  const f = fixture(); authorize.mockRejectedValueOnce(new Error("workspace_access_refused"));
  await expect(f.issue()).rejects.toThrow("workspace_access_refused");
  expect(f.clients()).toBe(0); expect(f.registered).toHaveLength(0);
});
