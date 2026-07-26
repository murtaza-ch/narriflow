-- Multi-provider link ingest: generalize YouTube-only import to 11 providers.

ALTER TYPE "SourceType" ADD VALUE IF NOT EXISTS 'link';
ALTER TYPE "IngestJobType" ADD VALUE IF NOT EXISTS 'link_import';

ALTER TABLE "Project" ADD COLUMN "sourceProvider" TEXT;
