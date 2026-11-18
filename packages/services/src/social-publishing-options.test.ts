import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { afterEach, expect, spyOn, test } from "bun:test";
import type { PrismaClient } from "@prisma/client";
import { socialPublishingOptions } from "./social-publishing-options";
import { SocialOAuthError, socialOAuthService, type PublishSocialAccount } from "./social-oauth.service";
import { workspaceService } from "./workspace.service";

const globals = createDatabaseTestContext();
const previous = globals.client;
const previousUrl = process.env.DATABASE_URL;
const mocks: Array<{ mockRestore(): void }> = [];
afterEach(bindServiceTestEnvironment(globals.bind(() => { globals.client = previous; if (previousUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = previousUrl; for (const mock of mocks.splice(0)) mock.mockRestore(); })));

test("publishing options permit workspace readers and expose product facts without credentials", bindServiceTestEnvironment(globals.bind(async () => {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  const admission = spyOn(workspaceService, "requireActor").mockResolvedValue({ actorUserId: "user", workspaceId: "workspace", workspaceName: "Team", workspaceOwnerUserId: "owner", role: "viewer", status: "active", pricingTier: "business", isPersonalWorkspace: false });
  mocks.push(admission);
  const credential = spyOn(socialOAuthService, "getPublishAccount").mockResolvedValue({ id: "account", accessToken: "private-access-token" } as unknown as PublishSocialAccount);
  mocks.push(credential);
  let where: unknown;
  globals.client = { socialAccount: { findFirst: async (input: { where: unknown }) => { where = input.where; return { id: "account", workspaceId: "workspace", platform: "youtube_shorts", status: "active", scopes: [], encryptedAccessToken: "private-access-token" }; }, findUnique: async () => ({ status: "active" }) } } as unknown as PrismaClient;
  const result = await socialPublishingOptions({ actorUserId: "user", workspaceId: "workspace" }, "account");
  expect(admission).toHaveBeenCalledWith("user", "workspace", "content.view");
  expect(where).toEqual({ id: "account", workspaceId: "workspace" });
  expect(result).toMatchObject({ platform: "youtube_shorts", directEnabled: true });
  expect(JSON.stringify(result)).not.toContain("private-access-token");
})));

function arrange(row: { platform: string; status: string } | null, credential?: () => Promise<PublishSocialAccount>) {
  process.env.DATABASE_URL = "postgresql://test:test@127.0.0.1:1/test";
  mocks.push(spyOn(workspaceService, "requireActor").mockResolvedValue({ actorUserId: "user", workspaceId: "workspace", workspaceOwnerUserId: "owner", role: "viewer", status: "active", pricingTier: "business", isPersonalWorkspace: false }));
  const load = spyOn(socialOAuthService, "getPublishAccount").mockImplementation(credential ?? (async () => ({ id: "account", accessToken: "token" }) as unknown as PublishSocialAccount));
  mocks.push(load);
  globals.client = { socialAccount: { findFirst: async () => row && { id: "account", workspaceId: "workspace", scopes: [], ...row }, findUnique: async () => row && { status: row.status } } } as unknown as PrismaClient;
  return load;
}
const options = () => socialPublishingOptions({ actorUserId: "user", workspaceId: "workspace" }, "account");

for (const platform of ["youtube_shorts", "linkedin", "x", "instagram_reels", "facebook_reels"]) {
  test(`${platform} runs the refresh preflight and maps a dead connection to a reconnect failure`, bindServiceTestEnvironment(globals.bind(async () => {
    const load = arrange({ platform, status: "active" }, async () => { throw new SocialOAuthError("social_account_expired", "expired"); });
    await expect(options()).rejects.toMatchObject({ code: "social_account_reconnect_required", kind: "conflict", message: "Reconnect this account to publish." });
    expect(load).toHaveBeenCalledTimes(1);
  })));
}

test("a missing or inactive account is a reconnect failure and never reaches the provider", bindServiceTestEnvironment(globals.bind(async () => {
  const load = arrange({ platform: "youtube_shorts", status: "expired" });
  await expect(options()).rejects.toMatchObject({ code: "social_account_reconnect_required", kind: "conflict" });
  globals.client = { socialAccount: { findFirst: async () => null } } as unknown as PrismaClient;
  await expect(options()).rejects.toMatchObject({ code: "social_account_reconnect_required" });
  expect(load).not.toHaveBeenCalled();
})));

test("a refresh in progress or a provider failure stays unavailable, not a reconnect verdict", bindServiceTestEnvironment(globals.bind(async () => {
  arrange({ platform: "youtube_shorts", status: "active" }, async () => { throw new SocialOAuthError("social_account_refresh_in_progress", "busy", 503); });
  await expect(options()).rejects.toMatchObject({ code: "social_account_unavailable", kind: "unavailable" });
  mocks.pop()!.mockRestore();
  mocks.push(spyOn(socialOAuthService, "getPublishAccount").mockRejectedValue(new TypeError("fetch failed")));
  await expect(options()).rejects.toMatchObject({ code: "social_account_unavailable" });
})));

test("TikTok reads creator settings with the account the preflight loaded, without loading it twice", bindServiceTestEnvironment(globals.bind(async () => {
  const load = arrange({ platform: "tiktok", status: "active" }, async () => ({ id: "account", accessToken: "tiktok-token" }) as unknown as PublishSocialAccount);
  globals.client = { socialAccount: { findFirst: async () => ({ id: "account", workspaceId: "workspace", platform: "tiktok", status: "active", scopes: ["video.publish"] }), findUnique: async () => ({ status: "active" }) } } as unknown as PrismaClient;
  const calls: Array<{ url: string; auth: string | null }> = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (url: unknown, init?: { headers?: Record<string, string> }) => {
    calls.push({ url: String(url), auth: init?.headers?.Authorization ?? null });
    return new Response(JSON.stringify({ data: { privacy_level_options: ["SELF_ONLY"], max_video_post_duration_sec: 600 }, error: { code: "ok" } }), { status: 200 });
  }) as typeof fetch;
  try {
    expect(await options()).toMatchObject({ platform: "tiktok", privacyOptions: ["SELF_ONLY"], maximumDurationSec: 600 });
  } finally { globalThis.fetch = realFetch; }
  expect(load).toHaveBeenCalledTimes(1);
  expect(calls).toEqual([{ url: "https://open.tiktokapis.com/v2/post/publish/creator_info/query/", auth: "Bearer tiktok-token" }]);
})));
