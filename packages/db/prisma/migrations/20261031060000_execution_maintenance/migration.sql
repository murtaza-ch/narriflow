-- Exact due-key pages use both ordering columns; the old prefix-only index is redundant.
DROP INDEX "McpTask_expiresAt_idx";
CREATE INDEX "McpTask_expiresAt_id_idx" ON "McpTask" ("expiresAt", "id");
