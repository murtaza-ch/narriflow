-- Library search: embedded transcript passages for semantic plus full-text
-- search across a Workspace. The extension lives in public and every vector
-- reference is qualified, so migrations that run with another search_path (the
-- disposable-schema gates) resolve it too. See docs/runbooks/environments.md.
CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public;

-- AlterTable
ALTER TABLE "Transcript"
    ADD COLUMN "passagesIndexedFor" TIMESTAMP(3),
    ADD COLUMN "passagesAttempts" INTEGER NOT NULL DEFAULT 0,
    ADD COLUMN "passagesRetryAt" TIMESTAMP(3),
    ADD COLUMN "passagesIndexError" TEXT;

-- CreateTable
CREATE TABLE "TranscriptPassage" (
    "id" UUID NOT NULL,
    "workspaceId" UUID NOT NULL,
    "projectId" UUID NOT NULL,
    "transcriptId" UUID NOT NULL,
    "startMs" INTEGER NOT NULL,
    "endMs" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "embedding" public.vector(1536) NOT NULL,
    "embeddingModel" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "searchText" tsvector GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranscriptPassage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TranscriptPassage_transcriptId_contentHash_key" ON "TranscriptPassage"("transcriptId", "contentHash");

-- CreateIndex
CREATE INDEX "TranscriptPassage_workspaceId_idx" ON "TranscriptPassage"("workspaceId");

-- CreateIndex
CREATE INDEX "TranscriptPassage_projectId_idx" ON "TranscriptPassage"("projectId");

-- CreateIndex
CREATE INDEX "TranscriptPassage_searchText_idx" ON "TranscriptPassage" USING gin ("searchText");

-- CreateIndex
CREATE INDEX "TranscriptPassage_embedding_idx" ON "TranscriptPassage" USING hnsw ("embedding" public.vector_cosine_ops);

-- AddForeignKey
ALTER TABLE "TranscriptPassage" ADD CONSTRAINT "TranscriptPassage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TranscriptPassage" ADD CONSTRAINT "TranscriptPassage_transcriptId_fkey" FOREIGN KEY ("transcriptId") REFERENCES "Transcript"("id") ON DELETE CASCADE ON UPDATE CASCADE;
