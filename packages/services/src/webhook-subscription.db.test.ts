import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { WEBHOOK_SUBSCRIPTION_LIMIT } from "@narriflow/validators";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import {
	createCallbackCipher,
	prepareCallbackRegistration,
} from "./completion-callback";
import {
	createWebhookSubscriptions,
} from "./webhook-subscription";
const url = process.env.SERVERLESS_TEST_DATABASE_URL;
const suite =
	process.env.ALLOW_SERVERLESS_DB_TESTS === "1" && url
		? describe
		: describe.skip;
suite("Webhook management", () => {
	let db: PrismaClient;
	const cipher = createCallbackCipher("webhook-management-gate");
	beforeAll(() => {
		const schema = process.env.SERVERLESS_TEST_DATABASE_SCHEMA ?? "public";
		assertExecutionDatabaseTestTarget(url, schema);
		if (!schema.startsWith("serverless_execution_test_"))
			throw new Error("Disposable schema required");
		db = new PrismaClient({
			adapter: new PrismaPg({ connectionString: url, max: 4 }, { schema }),
		});
	});
	afterAll(async () => {
		await db?.$disconnect();
	});
	async function fixture() {
		const owner = await db.user.create({
			data: {
				clerkId: `webhook-management:${crypto.randomUUID()}`,
				primaryEmail: `owner-${crypto.randomUUID()}@example.test`,
				emailVerifiedAt: new Date(),
			},
		});
		const workspace = await db.workspace.create({
			data: {
				name: "Webhook gate",
				ownerUserId: owner.id,
				personalOwnerUserId: owner.id,
				pricingTier: "pro",
				members: { create: { userId: owner.id, role: "owner" } },
			},
		});
		const scope = { workspaceId: workspace.id, actorUserId: owner.id };
		const service = createWebhookSubscriptions({ prisma: db, cipher });
		return { scope, service, owner, workspace };
	}
	test("creation starts at committed head, requires a secret, and respects workspace and endpoint limits", async () => {
		const f = await fixture(),
			input = {
				url: new URL("https://receiver.example/webhook"),
				types: ["operation.finished" as const],
			};
		await expect(f.service.create(f.scope, input)).rejects.toMatchObject({
			code: "callback_secret_required",
		});
		await db.callbackSigningSecret.create({
			data: {
				workspaceId: f.workspace.id,
				encryptedSecret: cipher.seal("whsec_gate"),
			},
		});
		await db.workspaceEventCounter.create({
			data: { workspaceId: f.workspace.id, lastSeq: 12n },
		});
		const created = await f.service.create(f.scope, input);
		expect(created.lastDeliveredSeq).toBe(12);
		expect(created.urlHost).toBe("receiver.example");
		await expect(f.service.create(f.scope, input)).rejects.toMatchObject({
			code: "webhook_exists",
		});
		for (let n = 1; n < WEBHOOK_SUBSCRIPTION_LIMIT; n++)
			await f.service.create(f.scope, {
				...input,
				url: new URL(`https://receiver.example/${n}`),
			});
		await expect(
			f.service.create(f.scope, {
				...input,
				url: new URL("https://receiver.example/overflow"),
			}),
		).rejects.toMatchObject({ code: "webhook_limit_reached" });
		const other = await fixture();
		expect(await f.service.list(other.scope)).toEqual([]);
		await expect(
			f.service.delete(other.scope, created.webhookId),
		).rejects.toMatchObject({ kind: "missing" });
	});
	test("test admission retains caller intent and checks publishing scopes before the delivery port", async () => {
		const f = await fixture();
		const sub = await db.webhookSubscription.create({
			data: {
				workspaceId: f.workspace.id,
				createdByUserId: f.owner.id,
				...prepareCallbackRegistration(
					new URL("https://receiver.example/test"),
					cipher,
				),
				types: ["social_post.finished"],
				lastDeliveredSeq: 2n,
			},
		});
		const calls: string[] = [];
		const service = createWebhookSubscriptions({
			prisma: db,
			cipher,
			delivery: () => ({
				admitTest: async (_scope, id, intent) => {
					calls.push(`${id}:${intent}`);
					return {
						deliveryId: crypto.randomUUID(),
						eventId: crypto.randomUUID(),
						state: "pending" as const,
						status: null,
						durationMs: null,
					};
				},
				getTest: async () => ({
					deliveryId: crypto.randomUUID(),
					eventId: crypto.randomUUID(),
					state: "delivered" as const,
					status: 204,
					durationMs: 1,
				}),
			}),
		});
		await expect(
			service.test(f.scope, sub.id, "intent", { scopes: ["projects:read"] }),
		).rejects.toMatchObject({ kind: "forbidden" });
		expect(calls).toHaveLength(0);
		expect(
			(
				await service.test(f.scope, sub.id, "same-intent", {
					scopes: ["publishing:read"],
				})
			).state,
		).toBe("pending");
		expect(calls).toEqual([`${sub.id}:same-intent`]);
		expect(
			(
				await db.webhookSubscription.findUniqueOrThrow({
					where: { id: sub.id },
				})
			).lastDeliveredSeq,
		).toBe(2n);
	});
});
