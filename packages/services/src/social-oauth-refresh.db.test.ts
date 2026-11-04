import { bindServiceTestEnvironment } from "./runtime-test-support";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { randomUUID } from "node:crypto";
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	setDefaultTimeout,
	test,
} from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { SocialOAuthError, socialOAuthService } from "./social-oauth.service";
import { publicationPlanRefusal, requirePublishableSocialAccount } from "./social-account-eligibility";

process.env.SOCIAL_TOKEN_ENCRYPTION_KEY ??= "social-oauth-refresh-test-key-not-a-secret";
process.env.TIKTOK_CLIENT_KEY ??= "test-client-key";
process.env.TIKTOK_CLIENT_SECRET ??= "test-client-secret";
process.env.GOOGLE_CLIENT_ID ??= "test-google-id";
process.env.GOOGLE_CLIENT_SECRET ??= "test-google-secret";
process.env.LINKEDIN_CLIENT_ID ??= "test-linkedin-id";
process.env.LINKEDIN_CLIENT_SECRET ??= "test-linkedin-secret";
process.env.X_CLIENT_ID ??= "test-x-id";
process.env.META_CLIENT_ID ??= "test-meta-id";
process.env.META_CLIENT_SECRET ??= "test-meta-secret";

const databaseUrl = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_URL;
const databaseSchema = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_SCHEMA;
const dbDescribe =
	process.env.ALLOW_SOCIAL_PUBLICATION_DB_TESTS === "1" && databaseUrl
		? describe
		: describe.skip;

setDefaultTimeout(180_000);

const tokenResponse = (n: number) =>
	new Response(
		JSON.stringify({
			access_token: `access-${n}`,
			refresh_token: `refresh-${n}`,
			expires_in: 3_600,
			scope: "video.list",
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);

dbDescribe("Social account token refresh PostgreSQL invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previousGlobalPrisma: PrismaClient | undefined;
	const originalFetch = globalThis.fetch;
	const prismaGlobal = createDatabaseTestContext();

	beforeAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		pool = new Pool({ connectionString: databaseUrl!, max: 8 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
		});
		previousGlobalPrisma = prismaGlobal.client;
		prismaGlobal.client = prisma;
	})));

	afterEach(bindServiceTestEnvironment(prismaGlobal.bind(() => {
		globalThis.fetch = originalFetch;
	})));

	afterAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		prismaGlobal.client = previousGlobalPrisma;
		await prisma?.$disconnect();
		await pool?.end();
	})));

	/** An account whose access token is about to expire, so the next read refreshes it. */
	async function expiringAccount(platform: "tiktok" | "youtube_shorts" | "linkedin" | "x" = "tiktok", expiresInMs = 10_000) {
		const user = await prisma.user.create({ data: { clerkId: `oauth-refresh:${randomUUID()}` } });
		const workspace = await prisma.workspace.create({
			data: {
				name: "OAuth refresh",
				ownerUserId: user.id,
				personalOwnerUserId: user.id,
				pricingTier: "creator",
				members: { create: { userId: user.id, role: "owner" } },
			},
		});
		// The connect flow owns encryption; seed through its private upsert.
		const upsert = (
			socialOAuthService as unknown as {
				upsertAccount(
					scope: { actorUserId: string; workspaceId: string; credentialOwnerUserId: string },
					platform: "tiktok" | "youtube_shorts" | "linkedin" | "x",
					input: Record<string, unknown>,
				): Promise<{ id: string }>;
			}
		).upsertAccount.bind(socialOAuthService);
		const account = await upsert(
			{ actorUserId: user.id, workspaceId: workspace.id, credentialOwnerUserId: user.id },
			platform,
			{
				providerAccountId: randomUUID(),
				displayName: "TikTok",
				accessToken: "access-0",
				refreshToken: "refresh-0",
				expiresAt: new Date(Date.now() + expiresInMs),
				scopes: ["video.list"],
			},
		);
		return account.id;
	}

	const stored = (id: string) =>
		prisma.socialAccount.findUniqueOrThrow({
			where: { id },
			select: { accessTokenEncrypted: true, refreshTokenEncrypted: true, status: true },
		});

	test.each(["rotated", "unchanged", "no expiry"])("concurrent refreshes make one provider exchange when the response is %s", bindServiceTestEnvironment(prismaGlobal.bind(async (response) => {
		const id = await expiringAccount();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			const n = calls;
			// A provider can reject the losing exchange before the winning
			// response is stored. Write fencing alone cannot recover that race.
			if (n > 1) return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
			await new Promise((resolve) => setTimeout(resolve, 50));
			return response === "rotated" ? tokenResponse(n) : Response.json({ access_token: "access-1", ...(response === "no expiry" ? {} : { expires_in: 3600 }) });
		}) as typeof fetch;

		const results = await Promise.allSettled([
			socialOAuthService.getPublishAccount(id),
			socialOAuthService.getPublishAccount(id),
		]);
		expect(results.some(result=>result.status==="fulfilled")).toBe(true);
    for(const result of results)if(result.status==="rejected")expect(result.reason).toMatchObject({code:"social_account_refresh_in_progress",status:503});
		for (const result of results) if (result.status === "fulfilled") expect(result.value.accessToken).toBe("access-1");
		expect(calls).toBe(1);
		expect((await socialOAuthService.getPublishAccount(id)).accessToken).toBe("access-1");
		expect(calls).toBe(1);
	})));

	test.each([
		["a 5xx", async () => new Response("bad gateway", { status: 502 })],
		["a transport failure", async () => { throw new Error("socket closed"); }],
	])("a rotating provider's started refresh ending in %s keeps the old tokens unusable and requires reconnect instead of another POST", bindServiceTestEnvironment(prismaGlobal.bind(async (_name, answer) => {
		const id = await expiringAccount();
		const before = await stored(id);
		globalThis.fetch = answer as unknown as typeof fetch;

		const failure = await socialOAuthService.getPublishAccount(id).catch((error) => error);
		expect(failure).toBeInstanceOf(SocialOAuthError);
		expect(failure).toMatchObject({code:"social_account_refresh_unconfirmed",status:409});
    expect(await stored(id)).toEqual({...before,status:"expired"});
    await expect(socialOAuthService.getPublishAccount(id)).rejects.toMatchObject({code:"social_account_refresh_in_progress"});
	})));

	test.each([400, 401, 429])("an HTTP %d refusal that is not a dead grant proves nothing rotated: the account stays active and the next read retries", bindServiceTestEnvironment(prismaGlobal.bind(async (status) => {
		const id = await expiringAccount();
		let calls = 0;
		const bodies: string[] = [];
		globalThis.fetch = (async (_url: unknown, init?: RequestInit) => {
			calls += 1;
			bodies.push(String(init?.body));
			return calls === 1 ? new Response(JSON.stringify({ error: "refused" }), { status }) : tokenResponse(calls);
		}) as typeof fetch;

		await expect(socialOAuthService.getPublishAccount(id)).rejects.toMatchObject({ code: "social_oauth_http_failed", status });
		expect((await stored(id)).status).toBe("active");
		const marker = await prisma.socialAccount.findUniqueOrThrow({ where: { id }, select: { tokenRefreshOwner: true, tokenRefreshLeaseExpiresAt: true, tokenRefreshStartedAt: true } });
		expect(marker).toEqual({ tokenRefreshOwner: null, tokenRefreshLeaseExpiresAt: null, tokenRefreshStartedAt: null });

		expect((await socialOAuthService.getPublishAccount(id)).accessToken).toBe("access-2");
		expect(calls).toBe(2);
		// The retry still presents the original refresh token.
		expect(bodies[1]).toContain("refresh_token=refresh-0");
	})));

	/** What each provider documents or is observed to answer for a refresh token that is dead. */
	const deadGrants: Array<[string, "tiktok" | "youtube_shorts" | "linkedin" | "x", number, Record<string, unknown>]> = [
		["TikTok invalid_grant", "tiktok", 400, { error: "invalid_grant", error_description: "Refresh token is invalid or expired.", log_id: "x" }],
		["Google invalid_grant", "youtube_shorts", 400, { error: "invalid_grant", error_description: "Token has been expired or revoked." }],
		["LinkedIn revoked refresh token", "linkedin", 400, { error: "invalid_request", error_description: "The provided authorization grant or refresh token is invalid, expired or revoked" }],
		["X consumed refresh token", "x", 400, { error: "invalid_request", error_description: "Value passed for the token was invalid." }],
		["an RFC 6750 invalid_token", "x", 401, { error: "invalid_token" }],
	];
	test.each(deadGrants)("%s expires the account, releases the claim and tells the user to reconnect", bindServiceTestEnvironment(prismaGlobal.bind(async (_name, platform, status, body) => {
		const id = await expiringAccount(platform);
		let calls = 0;
		globalThis.fetch = (async () => { calls += 1; return new Response(JSON.stringify(body), { status }); }) as typeof fetch;
		const failure = await socialOAuthService.getPublishAccount(id).catch((error) => error);
		expect(failure).toBeInstanceOf(SocialOAuthError);
		expect(failure).toMatchObject({ code: "social_account_expired" });
		expect(failure.message).toContain("Reconnect");
		expect((await stored(id)).status).toBe("expired");
		const marker = await prisma.socialAccount.findUniqueOrThrow({ where: { id }, select: { tokenRefreshOwner: true, tokenRefreshLeaseExpiresAt: true, tokenRefreshStartedAt: true } });
		expect(marker).toEqual({ tokenRefreshOwner: null, tokenRefreshLeaseExpiresAt: null, tokenRefreshStartedAt: null });
		expect(calls).toBe(1);
	})));

	test("a provider that answers 200 with an OAuth error body is a refusal too", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const id = await expiringAccount("tiktok");
		globalThis.fetch = (async () => Response.json({ error: "invalid_grant", error_description: "Refresh token is invalid or expired." })) as typeof fetch;
		await expect(socialOAuthService.getPublishAccount(id)).rejects.toMatchObject({ code: "social_account_expired" });
		expect((await stored(id)).status).toBe("expired");
	})));

	/** Everything that is not a dead grant keeps the account usable. */
	const notDead: Array<[string, "tiktok" | "youtube_shorts" | "linkedin" | "x", () => Response | Promise<never>, number | undefined]> = [
		["TikTok misconfigured client", "tiktok", () => new Response(JSON.stringify({ error: "invalid_client" }), { status: 401 }), 401],
		["LinkedIn missing parameter", "linkedin", () => new Response(JSON.stringify({ error: "invalid_request", error_description: 'A required parameter "refresh_token" is missing' }), { status: 400 }), 400],
		["X throttling", "x", () => new Response(JSON.stringify({ title: "Too Many Requests" }), { status: 429 }), 429],
		["Google throttling", "youtube_shorts", () => new Response(JSON.stringify({ error: "rate_limit_exceeded" }), { status: 429 }), 429],
		["Google 503", "youtube_shorts", () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 503 }), 503],
		["Google transport failure", "youtube_shorts", () => { throw new Error("socket closed"); }, undefined],
		["Google 200 without a token", "youtube_shorts", () => Response.json({ expires_in: 3_600 }), undefined],
	];
	test.each(notDead)("%s never expires the account and keeps the provider's answer as the cause", bindServiceTestEnvironment(prismaGlobal.bind(async (_name, platform, answer, status) => {
		const id = await expiringAccount(platform);
		globalThis.fetch = (async () => answer()) as typeof fetch;
		const failure = await socialOAuthService.getPublishAccount(id).catch((error) => error);
		expect(failure.code).not.toBe("social_account_expired");
		if (status !== undefined) expect(failure).toMatchObject({ code: "social_oauth_http_failed", status });
		expect((await stored(id)).status).toBe("active");
	})));

	test.each(["a 5xx", "a transport failure"])("Google never rotates, so %s leaves the account active for a retry", bindServiceTestEnvironment(prismaGlobal.bind(async (kind) => {
		const id = await expiringAccount("youtube_shorts");
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			if (calls > 1) return Response.json({ access_token: "access-2", expires_in: 3_600 });
			if (kind === "a 5xx") return new Response("unavailable", { status: 503 });
			throw new Error("socket closed");
		}) as typeof fetch;

		await expect(socialOAuthService.getPublishAccount(id)).rejects.toMatchObject(kind === "a 5xx" ? { code: "social_oauth_http_failed", status: 503 } : { message: "socket closed" });
		expect((await stored(id)).status).toBe("active");
		expect((await socialOAuthService.getPublishAccount(id)).accessToken).toBe("access-2");
		expect(calls).toBe(2);
	})));

	test("a token that expires within the publication window is refreshed before the publish starts", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const id = await expiringAccount("tiktok", 5 * 60_000);
		let calls = 0;
		globalThis.fetch = (async () => tokenResponse(++calls)) as typeof fetch;
		expect((await socialOAuthService.getPublishAccount(id)).accessToken).toBe("access-1");
		expect(calls).toBe(1);

		const later = await expiringAccount("tiktok", 8 * 60_000);
		expect((await socialOAuthService.getPublishAccount(later)).accessToken).toBe("access-0");
		expect(calls).toBe(1);
	})));

	/** An Instagram callback served by a fake Meta; `pages` is how many Pages `/me/accounts` lists, 100 per request. */
	async function instagramCallback(options: { pages?: number; longLived?: "ok" | "fail" } = {}) {
		const user = await prisma.user.create({ data: { clerkId: `oauth-instagram:${randomUUID()}` } });
		const workspace = await prisma.workspace.create({
			data: { name: "Instagram", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier: "pro", members: { create: { userId: user.id, role: "owner" } } },
		});
		const state = `state-${randomUUID()}`;
		await prisma.socialOAuthState.create({ data: { userId: user.id, workspaceId: workspace.id, createdByUserId: user.id, platform: "instagram_reels", state, expiresAt: new Date(Date.now() + 60_000) } });
		const total = options.pages ?? 1;
		const requests: URL[] = [];
		globalThis.fetch = (async (input: Parameters<typeof fetch>[0]) => {
			const url = new URL(String(input));
			requests.push(url);
			if (url.pathname.endsWith("/oauth/access_token")) {
				if (url.searchParams.get("grant_type") === "fb_exchange_token") {
					return options.longLived === "fail" ? new Response("{}", { status: 500 }) : Response.json({ access_token: "long-user-token", token_type: "bearer", expires_in: 5_183_944 });
				}
				// Meta's code exchange has no `scope`.
				return Response.json({ access_token: "short-user-token", token_type: "bearer", expires_in: 3_600 });
			}
			if (url.pathname.endsWith("/me/permissions")) {
				return Response.json({ data: [{ permission: "instagram_content_publish", status: "granted" }, { permission: "pages_show_list", status: "granted" }, { permission: "business_management", status: "declined" }] });
			}
			if (url.pathname.endsWith("/me/accounts")) {
				const offset = Number(url.searchParams.get("offset") ?? 0);
				const limit = Number(url.searchParams.get("limit"));
				const data = Array.from({ length: Math.min(limit, total - offset) }, (_, i) => ({
					id: `page-${offset + i}`, name: `Page ${offset + i}`, access_token: `page-token-${offset + i}`,
					instagram_business_account: { id: `ig-${offset + i}`, username: `user${offset + i}` },
				}));
				const next = offset + limit < total ? new URL(url) : null;
				next?.searchParams.set("offset", String(offset + limit));
				return Response.json({ data, paging: next ? { next: next.toString() } : {} });
			}
			throw new Error(`unexpected request ${url}`);
		}) as typeof fetch;
		const result = await socialOAuthService.handleCallback({ state, code: "code", origin: "https://api.example.test" });
		return { result, requests, workspaceId: workspace.id };
	}

	test("an Instagram account stores the permissions Meta reports and no user-token expiry, so it can publish", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const { result, requests } = await instagramCallback();
		expect(result.accounts).toHaveLength(1);
		const account = await socialOAuthService.getPublishAccount(result.accounts[0]!.id);
		expect(account.scopes).toEqual(["instagram_content_publish", "pages_show_list"]);
		expect(account.accessToken).toBe("page-token-0");
		expect(result.accounts[0]!.expiresAt).toBeNull();
		expect(requests.find((url) => url.pathname.endsWith("/me/accounts"))!.searchParams.get("limit")).toBe("100");
	})));

	test("Pages beyond the first Meta response are requested, 100 at a time", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const { requests } = await instagramCallback({ pages: 230 });
		const listings = requests.filter((url) => url.pathname.endsWith("/me/accounts"));
		expect(listings.map((url) => url.searchParams.get("offset"))).toEqual([null, "100", "200"]);
	})));

	test("a failed long-lived exchange refuses the connection instead of storing the short-lived token", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const user = await prisma.socialAccount.count();
		await expect(instagramCallback({ longLived: "fail" })).rejects.toMatchObject({ code: "social_oauth_http_failed", status: 500 });
		expect(await prisma.socialAccount.count()).toBe(user);
	})));

	test.each([{}, { access_token: "" }])("a response with no access token never overwrites a good token: %j", bindServiceTestEnvironment(prismaGlobal.bind(async (token) => {
		const id = await expiringAccount();
		const before = await stored(id);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ ...token, expires_in: 3_600 }), { status: 200 })) as typeof fetch;

		await expect(socialOAuthService.getPublishAccount(id)).rejects.toMatchObject({
			code: "social_account_refresh_unconfirmed",
		});
		expect(await stored(id)).toEqual({...before,status:"expired"});
	})));
});

dbDescribe("Social Destination plan count PostgreSQL invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previousGlobalPrisma: PrismaClient | undefined;
	const prismaGlobal = createDatabaseTestContext();

	beforeAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		pool = new Pool({ connectionString: databaseUrl!, max: 8 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
		});
		previousGlobalPrisma = prismaGlobal.client;
		prismaGlobal.client = prisma;
	})));

	afterAll(bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		prismaGlobal.client = previousGlobalPrisma;
		await prisma?.$disconnect();
		await pool?.end();
	})));

	type Saved = { id: string; providerAccountId: string; publishingEligible: boolean };
	// The OAuth callbacks end in this private save; the provider exchanges before it are not under test.
	const save = (
		socialOAuthService as unknown as {
			saveAccounts(
				scope: { actorUserId: string; workspaceId: string; credentialOwnerUserId: string },
				platform: "instagram_reels",
				inputs: Array<Record<string, unknown>>,
			): Promise<Saved[]>;
		}
	).saveAccounts.bind(socialOAuthService);
	const destination = (providerAccountId = randomUUID()) => ({
		providerAccountId, displayName: "Instagram", accessToken: "access", refreshToken: null, expiresAt: null, scopes: [],
	});

	async function workspace(pricingTier: "free" | "creator" | "pro") {
		const user = await prisma.user.create({ data: { clerkId: `destinations:${randomUUID()}` } });
		const created = await prisma.workspace.create({
			data: { name: "Destinations", ownerUserId: user.id, personalOwnerUserId: user.id, pricingTier, members: { create: { userId: user.id, role: "owner" } } },
		});
		const scope = { actorUserId: user.id, workspaceId: created.id, credentialOwnerUserId: user.id };
		return { scope, workspaceId: created.id, connect: (...ids: string[]) => save(scope, "instagram_reels", ids.map(destination)) };
	}
	const slots = (workspaceId: string) => prisma.socialAccount.count({ where: { workspaceId, status: { not: "revoked" } } });

	test("Free connects no destination; Creator's last slot goes to exactly one of two concurrent connects", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const free = await workspace("free");
		await expect(free.connect("a")).rejects.toMatchObject({ code: "plan_feature_required", details: { limit: "socialDestinations", requiredTier: "creator" } });

		const creator = await workspace("creator");
		await creator.connect("one", "two");
		const results = await Promise.allSettled([creator.connect("three"), creator.connect("four")]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "plan_limit_reached", details: { used: 3, max: 3, requiredTier: "pro" } } });
		expect(await slots(creator.workspaceId)).toBe(3);
	})));

	test("reconnecting an account at the cap is free, a revoked one needs a slot, and disconnecting frees one", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const creator = await workspace("creator");
		const [first] = await creator.connect("one", "two", "three");
		await expect(creator.connect("two")).resolves.toMatchObject([{ providerAccountId: "two", publishingEligible: true }]);
		await socialOAuthService.disconnectAccount(creator.scope, first!.id);
		await creator.connect("four");
		await expect(creator.connect("one")).rejects.toMatchObject({ code: "plan_limit_reached" });
		const four = await prisma.socialAccount.findFirstOrThrow({ where: { workspaceId: creator.workspaceId, providerAccountId: "four" } });
		await socialOAuthService.disconnectAccount(creator.scope, four.id);
		await expect(creator.connect("one")).resolves.toMatchObject([{ id: first!.id }]);
		expect(await slots(creator.workspaceId)).toBe(3);
	})));

	test("one grant with more destinations than free slots saves the first ones, in provider order", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const creator = await workspace("creator");
		await creator.connect("existing");
		const saved = await creator.connect("a", "existing", "b", "c");
		expect(saved.map((account) => account.providerAccountId)).toEqual(["a", "existing", "b"]);
		expect(await slots(creator.workspaceId)).toBe(3);
	})));

	test("after a downgrade the oldest accounts publish, the rest are plan-ineligible with their tokens kept", bindServiceTestEnvironment(prismaGlobal.bind(async () => {
		const pro = await workspace("pro");
		const ids: string[] = [];
		for (const name of ["a", "b", "c", "d", "e"]) ids.push((await pro.connect(name))[0]!.id);
		// Distinct connection times, oldest first.
		for (const [index, id] of ids.entries()) await prisma.socialAccount.update({ where: { id }, data: { createdAt: new Date(Date.UTC(2026, 0, 1 + index)) } });
		await prisma.workspace.update({ where: { id: pro.workspaceId }, data: { pricingTier: "creator" } });

		const listed = await socialOAuthService.listAccounts(pro.scope);
		expect(listed.filter((account) => account.publishingEligible).map((account) => account.id).sort()).toEqual(ids.slice(0, 3).sort());
		expect(await publicationPlanRefusal(prisma, { workspaceId: pro.workspaceId, socialAccountId: ids[0]!, customThumbnail: false })).toBeNull();
		// A frozen custom thumbnail Creator doesn't include stops the post instead of sending it without one.
		expect(await publicationPlanRefusal(prisma, { workspaceId: pro.workspaceId, socialAccountId: ids[0]!, customThumbnail: true })).toBe("publication_thumbnail_plan_required");
		expect(await publicationPlanRefusal(prisma, { workspaceId: pro.workspaceId, socialAccountId: ids[4]!, customThumbnail: false })).toBe("publication_account_beyond_plan");
		await expect(requirePublishableSocialAccount(prisma, { workspaceId: pro.workspaceId, accountId: ids[3]!, tier: "creator" }))
			.rejects.toMatchObject({ code: "plan_limit_reached", details: { limit: "socialDestinations", used: 5, max: 3 } });
		expect(await prisma.socialAccount.count({ where: { id: { in: ids }, status: "active", refreshTokenEncrypted: null, accessTokenEncrypted: { not: "" } } })).toBe(5);
		// Additions stay blocked while over the cap.
		await expect(pro.connect("f")).rejects.toMatchObject({ code: "plan_limit_reached" });

		// Disconnecting an older account makes the next one eligible.
		await socialOAuthService.disconnectAccount(pro.scope, ids[0]!);
		expect(await publicationPlanRefusal(prisma, { workspaceId: pro.workspaceId, socialAccountId: ids[3]!, customThumbnail: false })).toBeNull();
		await prisma.workspace.update({ where: { id: pro.workspaceId }, data: { pricingTier: "free" } });
		expect(await publicationPlanRefusal(prisma, { workspaceId: pro.workspaceId, socialAccountId: ids[1]!, customThumbnail: false })).toBe("publication_plan_required");
	})));
});
