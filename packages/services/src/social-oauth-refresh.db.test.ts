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
	const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl!, max: 8 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
		});
		previousGlobalPrisma = prismaGlobal.narriflowPrismaClient;
		prismaGlobal.narriflowPrismaClient = prisma;
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	afterAll(async () => {
		prismaGlobal.narriflowPrismaClient = previousGlobalPrisma;
		await prisma?.$disconnect();
		await pool?.end();
	});

	/** A TikTok account whose access token is about to expire, so the next read refreshes it. */
	async function expiringAccount() {
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
					platform: "tiktok",
					input: Record<string, unknown>,
				): Promise<{ id: string }>;
			}
		).upsertAccount.bind(socialOAuthService);
		const account = await upsert(
			{ actorUserId: user.id, workspaceId: workspace.id, credentialOwnerUserId: user.id },
			"tiktok",
			{
				providerAccountId: randomUUID(),
				displayName: "TikTok",
				accessToken: "access-0",
				refreshToken: "refresh-0",
				expiresAt: new Date(Date.now() + 10_000),
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

	test("workers refreshing at once converge on the first write", async () => {
		const id = await expiringAccount();
		let calls = 0;
		globalThis.fetch = (async () => {
			calls += 1;
			const n = calls;
			await new Promise((resolve) => setTimeout(resolve, 25));
			return tokenResponse(n);
		}) as typeof fetch;

		const [first, second] = await Promise.all([
			socialOAuthService.getPublishAccount(id),
			socialOAuthService.getPublishAccount(id),
		]);

		expect(calls).toBe(2);
		expect(first.accessToken).toBe(second.accessToken);
		expect(["access-1", "access-2"]).toContain(first.accessToken);
		// Later reads see the same single winner and don't refresh again.
		expect((await socialOAuthService.getPublishAccount(id)).accessToken).toBe(first.accessToken);
		expect(calls).toBe(2);
	});

	test("the loser of a rotated refresh token takes the winner's tokens instead of failing", async () => {
		const id = await expiringAccount();
		let calls = 0;
		let releaseWinner!: () => void;
		let releaseLoser!: () => void;
		const winnerGate = new Promise<void>((resolve) => (releaseWinner = resolve));
		const loserGate = new Promise<void>((resolve) => (releaseLoser = resolve));
		globalThis.fetch = (async () => {
			calls += 1;
			if (calls === 1) {
				await winnerGate;
				return tokenResponse(1);
			}
			await loserGate;
			// The provider already rotated the refresh token this call still holds.
			return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 });
		}) as typeof fetch;

		const winning = socialOAuthService.getPublishAccount(id);
		const losing = socialOAuthService.getPublishAccount(id);
		while (calls < 2) await new Promise((resolve) => setTimeout(resolve, 5));
		releaseWinner();
		const winner = await winning;
		releaseLoser();
		const loser = await losing;

		expect(winner.accessToken).toBe("access-1");
		expect(loser.accessToken).toBe("access-1");
	});

	test("a rejected refresh surfaces with its HTTP status and leaves the stored tokens alone", async () => {
		const id = await expiringAccount();
		const before = await stored(id);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as typeof fetch;

		const failure = await socialOAuthService.getPublishAccount(id).catch((error) => error);
		expect(failure).toBeInstanceOf(SocialOAuthError);
		expect(failure).toMatchObject({ code: "social_oauth_http_failed", status: 400 });
		expect(await stored(id)).toEqual(before);
	});

	test("a response with no access token never overwrites a good token", async () => {
		const id = await expiringAccount();
		const before = await stored(id);
		globalThis.fetch = (async () =>
			new Response(JSON.stringify({ expires_in: 3_600 }), { status: 200 })) as typeof fetch;

		await expect(socialOAuthService.getPublishAccount(id)).rejects.toMatchObject({
			code: "social_oauth_refresh_invalid",
		});
		expect(await stored(id)).toEqual(before);
	});
});

dbDescribe("Social Destination plan count PostgreSQL invariants", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previousGlobalPrisma: PrismaClient | undefined;
	const prismaGlobal = globalThis as unknown as { narriflowPrismaClient?: PrismaClient };

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl!, max: 8 });
		prisma = new PrismaClient({
			adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined),
		});
		previousGlobalPrisma = prismaGlobal.narriflowPrismaClient;
		prismaGlobal.narriflowPrismaClient = prisma;
	});

	afterAll(async () => {
		prismaGlobal.narriflowPrismaClient = previousGlobalPrisma;
		await prisma?.$disconnect();
		await pool?.end();
	});

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

	test("Free connects no destination; Creator's last slot goes to exactly one of two concurrent connects", async () => {
		const free = await workspace("free");
		await expect(free.connect("a")).rejects.toMatchObject({ code: "plan_feature_required", details: { limit: "socialDestinations", requiredTier: "creator" } });

		const creator = await workspace("creator");
		await creator.connect("one", "two");
		const results = await Promise.allSettled([creator.connect("three"), creator.connect("four")]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "plan_limit_reached", details: { used: 3, max: 3, requiredTier: "pro" } } });
		expect(await slots(creator.workspaceId)).toBe(3);
	});

	test("reconnecting an account at the cap is free, a revoked one needs a slot, and disconnecting frees one", async () => {
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
	});

	test("one grant with more destinations than free slots saves the first ones, in provider order", async () => {
		const creator = await workspace("creator");
		await creator.connect("existing");
		const saved = await creator.connect("a", "existing", "b", "c");
		expect(saved.map((account) => account.providerAccountId)).toEqual(["a", "existing", "b"]);
		expect(await slots(creator.workspaceId)).toBe(3);
	});

	test("after a downgrade the oldest accounts publish, the rest are plan-ineligible with their tokens kept", async () => {
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
	});
});
