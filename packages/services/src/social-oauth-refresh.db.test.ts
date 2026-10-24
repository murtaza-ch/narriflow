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
