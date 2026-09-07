-- A Workspace customer operation is intentionally stable across Checkout
-- attempts so provider replay can recover one customer after an expired session.
DROP INDEX "WorkspaceCheckoutAttempt_customerOperationKey_key";

CREATE INDEX "WorkspaceCheckoutAttempt_customerOperationKey_idx"
  ON "WorkspaceCheckoutAttempt"("customerOperationKey");
