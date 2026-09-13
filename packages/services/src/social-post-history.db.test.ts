import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { SocialService } from "./social.service";

const databaseUrl = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_URL;
const databaseSchema = process.env.SOCIAL_PUBLICATION_TEST_DATABASE_SCHEMA;
const dbDescribe = process.env.ALLOW_SOCIAL_PUBLICATION_DB_TESTS === "1" && databaseUrl ? describe : describe.skip;

dbDescribe("Social Post history PostgreSQL", () => {
	let prisma: PrismaClient;
	let pool: Pool;
	let previous: PrismaClient | undefined;
	const globalPrisma = globalThis as { narriflowPrismaClient?: PrismaClient };

	beforeAll(async () => {
		pool = new Pool({ connectionString: databaseUrl!, max: 4 });
		prisma = new PrismaClient({ adapter: new PrismaPg(pool, databaseSchema ? { schema: databaseSchema } : undefined) });
		previous = globalPrisma.narriflowPrismaClient;
		globalPrisma.narriflowPrismaClient = prisma;
	});
	afterAll(async () => {
		globalPrisma.narriflowPrismaClient = previous;
		await prisma.$disconnect();
		await pool.end();
	});

	async function fixture() {
		const suffix = randomUUID();
		const user = await prisma.user.create({ data: { clerkId: `history:${suffix}` } });
		const workspace = await prisma.workspace.create({ data: { name: "History", ownerUserId: user.id, personalOwnerUserId: user.id } });
		const project = await prisma.project.create({ data: { title: "History", sourceMediaUrl: "r2://history", userId: user.id, workspaceId: workspace.id, createdByUserId: user.id } });
		const base = new Date("2026-01-01T00:00:00.000Z");
		const rows = Array.from({ length: 205 }, (_, index) => ({
			id: randomUUID(), projectId: project.id, workspaceId: workspace.id, createdByUserId: user.id,
			platform: "youtube_shorts" as const, status: index < 101 ? "scheduled" as const : "posted" as const,
			clientIdempotencyKey: randomUUID(), immutableRequestHash: `history-${index}`, caption: `post ${index}`,
			createdAt: new Date(base.getTime() + index * 1000), scheduledFor: base,
		}));
		await prisma.socialPost.createMany({ data: rows });
		return { user, project, rows };
	}

	test("pages every post in newest-first order across a deleted and malformed cursor", async () => {
		const f = await fixture();
		const service = new SocialService();
		const first = await service.listProjectPosts(f.user.id, f.project.id);
		expect(first.items).toHaveLength(100);
		expect(first.items[0]!.caption).toBe("post 204");
		await prisma.socialPost.delete({ where: { id: first.items[99]!.id } });
		const second = await service.listProjectPosts(f.user.id, f.project.id, { cursor: first.nextCursor! });
		const third = await service.listProjectPosts(f.user.id, f.project.id, { cursor: second.nextCursor! });
		// The already-rendered first page retains its deleted row; continuation
		// still reaches every remaining row without a duplicate or query failure.
		expect([...first.items, ...second.items, ...third.items].map((post) => post.id)).toHaveLength(205);
		expect((await service.listProjectPosts(f.user.id, f.project.id, { cursor: "not-a-cursor" })).items[0]!.caption).toBe("post 204");
	});

	test("bounds tracked terminal reads and discovers new live posts", async () => {
		const f = await fixture();
		const service = new SocialService();
		const tracked = f.rows.slice(0, 101).map((row) => row.id);
		await prisma.socialPost.update({ where: { id: tracked[100]! }, data: { status: "posted" } });
		const terminal = await service.listProjectPosts(f.user.id, f.project.id, { activeOnly: true, trackedIds: tracked });
		expect(terminal.items).toHaveLength(100);
		expect(terminal.items.every((post) => tracked.includes(post.id))).toBe(true);
		const discovered = await service.listProjectPosts(f.user.id, f.project.id, { activeOnly: true });
		expect(discovered.items).toHaveLength(100);
		expect(discovered.items.every((post) => post.status === "scheduled")).toBe(true);
	});
});
