-- A small browser poster is available before native ingest starts.
ALTER TABLE "UploadSession" ADD COLUMN "thumbnailStorageKey" TEXT;
