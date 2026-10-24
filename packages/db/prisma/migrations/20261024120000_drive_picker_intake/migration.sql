-- Google Drive Picker intake: a drive_import Ingest Job downloads the chosen
-- file with the browser's short-lived access token, sealed on the job and
-- cleared by every terminal transition.
ALTER TYPE "IngestJobType" ADD VALUE IF NOT EXISTS 'drive_import';

ALTER TABLE "IngestJob" ADD COLUMN "sourceCredential" TEXT;
