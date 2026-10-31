import { createDatabaseScope, withDatabaseScope } from "@narriflow/db/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { ReviewService } from "../../../../../packages/services/src/review.service";
const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: process.env.REVIEW_TEST_URL, options: `-csearch_path=${process.env.REVIEW_TEST_SCHEMA}` }, { schema: process.env.REVIEW_TEST_SCHEMA }) });
const service = new ReviewService(async (_key, limit) => ({ allowed: true, availability: "available", remaining: limit, limit }));
await withDatabaseScope(createDatabaseScope({ createClient: () => ({ client: prisma, dispose: () => prisma.$disconnect() }) }), async () => {
  const result = await service.addComment(process.env.REVIEW_TEST_SESSION!, process.env.REVIEW_TEST_SECRET!, { body: "Concurrent guest comment" }, { clientIdempotencyKey: "cross-process-key" });
  process.stdout.write(JSON.stringify(result));
});
