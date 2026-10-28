import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { Pool } from "pg";
import { ReviewService } from "../../../../../packages/services/src/review.service";
const pool = new Pool({ connectionString: process.env.REVIEW_TEST_URL, options: `-csearch_path=${process.env.REVIEW_TEST_SCHEMA}` });
const prisma = new PrismaClient({ adapter: new PrismaPg(pool, { schema: process.env.REVIEW_TEST_SCHEMA }) });
(globalThis as unknown as { narriflowPrismaClient: PrismaClient }).narriflowPrismaClient = prisma;
const service = new ReviewService(async (_key, limit) => ({ allowed: true, availability: "available", remaining: limit, limit }));
try {
  const result = await service.addComment(process.env.REVIEW_TEST_SESSION!, process.env.REVIEW_TEST_SECRET!, { body: "Concurrent guest comment" }, { clientIdempotencyKey: "cross-process-key" });
  process.stdout.write(JSON.stringify(result));
} finally { await prisma.$disconnect(); await pool.end(); }
