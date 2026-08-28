-- Checkout lifecycle and payment state are separate provider facts. The
-- pre-production cutover intentionally removes the concatenated old shape.
ALTER TABLE "WorkspaceCheckoutAttempt"
  DROP COLUMN "sessionOutcome",
  ADD COLUMN "sessionStatus" TEXT,
  ADD COLUMN "paymentStatus" TEXT;
