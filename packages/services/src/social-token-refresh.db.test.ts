import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { refreshSocialAccountToken } from "./social-token-refresh";
const url = process.env.SERVERLESS_TEST_DATABASE_URL,
	suite =
		process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url
			? describe
			: describe.skip;
suite("Scoped social token refresh", () => {
	let db: PrismaClient;
	beforeAll(() => {
		const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
		assertExecutionDatabaseTestTarget(url, schema);
		db = new PrismaClient({
			adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }),
		});
	});
	afterAll(async () => {
		await db?.$disconnect();
	});
	async function fixture() {
		const user = await db.user.create({
				data: { clerkId: `refresh:${crypto.randomUUID()}` },
			}),
			workspace = await db.workspace.create({
				data: { name: "Refresh", ownerUserId: user.id },
			});
		return db.socialAccount.create({
			data: {
				userId: user.id,
				workspaceId: workspace.id,
				platform: "x",
				providerAccountId: crypto.randomUUID(),
				displayName: "Fixture",
				accessTokenEncrypted: "old-access",
				refreshTokenEncrypted: "old-refresh",
				expiresAt: new Date(Date.now() - 1000),
			},
		});
	}
	function gate() {
		let begin!: () => void, finish!: () => void;
		return {
			began: new Promise<void>((r) => (begin = r)),
			until: new Promise<void>((r) => (finish = r)),
			begin: () => begin(),
			finish: () => finish(),
		};
	}
	const replacement = {
		accessTokenEncrypted: "new-access",
		refreshTokenEncrypted: "new-refresh",
		expiresAt: new Date(Date.now() + 3600000),
		scopes: ["tweet.write"],
	};
	test("disconnect wins during provider IO without waiting on a SQL transaction", async () => {
		const account = await fixture(),
			io = gate();
		let calls = 0;
		const refresh = refreshSocialAccountToken({
			database: db,
			accountId: account.id,
			exchange: async () => {
				calls++;
				io.begin();
				await io.until;
				return replacement;
			},
		});
		await io.began;
		await Promise.race([
			db.socialAccount.update({
				where: { id: account.id },
				data: { status: "revoked" },
			}),
			new Promise((_, reject) =>
				setTimeout(
					() => reject(Error("Provider IO held the account transaction")),
					1000,
				),
			),
		]);
		io.finish();
		await expect(refresh).rejects.toMatchObject({
			code: "social_account_missing",
		});
		expect(calls).toBe(1);
		expect(
			(await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } }))
				.status,
		).toBe("revoked");
		expect(
			(await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } }))
				.accessTokenEncrypted,
		).toBe("old-access");
	});
	test("a rotating refresh token has one exchange owner and later callers read the committed replacement", async () => {
		const account = await fixture(),
			io = gate();
		let calls = 0;
		const exchange = async () => {
			calls++;
			io.begin();
			await io.until;
			return replacement;
		};
		const first = refreshSocialAccountToken({
			database: db,
			accountId: account.id,
			exchange,
		});
		await io.began;
		await expect(
			refreshSocialAccountToken({
				database: db,
				accountId: account.id,
				exchange,
			}),
		).rejects.toMatchObject({ code: "social_account_refresh_in_progress" });
		expect(calls).toBe(1);
		io.finish();
		const result = await first;
		expect(result.accessTokenEncrypted).toBe("new-access");
		expect(result.tokenRefreshOwner).toBeNull();
		expect(result.tokenRefreshStartedAt).toBeNull();
		expect(
			(
				await refreshSocialAccountToken({
					database: db,
					accountId: account.id,
					exchange,
				})
			).accessTokenEncrypted,
		).toBe("new-access");
		expect(calls).toBe(1);
	});
	test("explicit reconnect supersedes a started exchange without adopting its late response", async () => {
		const account = await fixture(), io = gate();
		const first = refreshSocialAccountToken({database:db,accountId:account.id,exchange:async()=>{io.begin();await io.until;return replacement;}});
		await io.began;
		await db.socialAccount.update({where:{id:account.id},data:{accessTokenEncrypted:"reconnected-access",refreshTokenEncrypted:"reconnected-refresh",status:"active",tokenRefreshOwner:null,tokenRefreshLeaseExpiresAt:null,tokenRefreshStartedAt:null}});
		io.finish();
		await expect(first).rejects.toMatchObject({code:"social_account_refresh_in_progress"});
		expect((await db.socialAccount.findUniqueOrThrow({where:{id:account.id}})).accessTokenEncrypted).toBe("reconnected-access");
	});
	test("an expired started exchange requires reconnect and never sends another refresh POST", async () => {
		const account = await fixture(),
			io = gate();
		let calls = 0;
		const exchange = async () => {
			calls++;
			io.begin();
			await io.until;
			return replacement;
		};
		const first = refreshSocialAccountToken({
			database: db,
			accountId: account.id,
			exchange,
		});
		await io.began;
		await db.$executeRaw`UPDATE "SocialAccount" SET "tokenRefreshLeaseExpiresAt"=clock_timestamp() AT TIME ZONE 'UTC'-interval '1 millisecond' WHERE "id"=${account.id}::uuid`;
		io.finish();
		await expect(first).rejects.toMatchObject({
			code: "social_account_refresh_unconfirmed",
		});
		await expect(
			refreshSocialAccountToken({
				database: db,
				accountId: account.id,
				exchange,
			}),
		).rejects.toMatchObject({ code: "social_account_refresh_unconfirmed" });
		expect(calls).toBe(1);
		expect(
			(await db.socialAccount.findUniqueOrThrow({ where: { id: account.id } }))
				.status,
		).toBe("expired");
	});
});
