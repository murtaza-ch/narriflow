-- Producer-frozen known-intent ranges use a strict createdAt/id cursor.
CREATE INDEX "MediaCleanupObligation_createdAt_id_idx" ON "MediaCleanupObligation"("createdAt", "id");

-- Exact immutable input holds must not scan historical attempts.
CREATE INDEX "ExecutionAttempt_inputStorageKey_idx" ON "ExecutionAttempt"("inputStorageKey");

CREATE INDEX "OutboundDelivery_bodyStorageKey_idx" ON "OutboundDelivery"("bodyStorageKey");

CREATE INDEX "MediaCleanupObligation_pending_due_cursor_idx" ON "MediaCleanupObligation"("nextAttemptAt", "id") WHERE "completedAt" IS NULL;
CREATE INDEX "ExecutionDispatch_cleanup_base_idx" ON "ExecutionDispatch"("deploymentEpoch", "subjectId", "generation" DESC)
  WHERE kind = 'operation_driver' AND "subjectKind" = 'media_cleanup' AND "wakeKind" IS NULL AND "deadlineKind" IS NULL;

-- A retry may move due time/ownership, never the destination or reference scope.
CREATE FUNCTION execution_cleanup_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id, NEW.origin, NEW."cleanupClass", NEW."objectKey", NEW."projectId", NEW."clipId", NEW."createdAt") IS DISTINCT FROM
     (OLD.id, OLD.origin, OLD."cleanupClass", OLD."objectKey", OLD."projectId", OLD."clipId", OLD."createdAt") THEN
    RAISE EXCEPTION 'execution_cleanup_identity_immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "MediaCleanupObligation_identity_immutable" BEFORE UPDATE ON "MediaCleanupObligation"
  FOR EACH ROW EXECUTE FUNCTION execution_cleanup_identity_guard();

-- Internal page receipts are independent of all signed executor audiences.
ALTER TABLE "ExecutionInboxReceipt" DROP CONSTRAINT "ExecutionInboxReceipt_bounded_check";
ALTER TABLE "ExecutionInboxReceipt" ADD CONSTRAINT "ExecutionInboxReceipt_bounded_check" CHECK (
  audience IN ('modal-bridge','executor-control','dev-device','watchdog','maintenance-page','restore-page')
  AND "requestHash" ~ '^[a-f0-9]{64}$' AND octet_length(disposition::text) <= 65536
  AND "expiresAt" > "committedAt"
);
