-- Additive: two nullable columns that current code never reads or writes, so it
-- is safe to apply before the code that uses them deploys.
ALTER TABLE "Transcript" ADD COLUMN "providerRequestId" TEXT,
ADD COLUMN "providerSubmissionDeadlineAt" TIMESTAMP(3);
