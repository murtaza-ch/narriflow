CREATE TABLE "GrantPauseNotificationLedger" (
 id UUID PRIMARY KEY,"workspaceId" UUID NOT NULL REFERENCES "Workspace"(id) ON DELETE CASCADE,
 "grantId" UUID NOT NULL REFERENCES "StandingGrant"(id) ON DELETE CASCADE,
 "pauseEventId" UUID NOT NULL UNIQUE REFERENCES "StandingGrantEvent"(id) ON DELETE CASCADE,
 "grantRevision" INTEGER NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
 "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 1,"claimToken" UUID,
 "operationDeadlineAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '23 hours'),
 "deliveryInputEncrypted" TEXT,"deliveryInputHash" TEXT,"deliveryContextFingerprint" TEXT,
 "submissionStartedAt" TIMESTAMP(3),"leaseExpiresAt" TIMESTAMP(3),"attemptCount" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"failureCode" TEXT,"providerMessageId" TEXT,"sentAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("grantId","grantRevision"),
 CONSTRAINT "GrantPauseNotification_execution_shape" CHECK (
  "deploymentEpoch">0 AND generation>0 AND "grantRevision">0 AND "attemptCount" BETWEEN 0 AND 3
  AND status IN ('pending','claimed','sent','failed','skipped')
  AND reason ~ '^[a-z][a-z0-9_]{0,99}$'
  AND "operationDeadlineAt"="createdAt"+INTERVAL '23 hours'
  AND (("claimToken" IS NULL)=("leaseExpiresAt" IS NULL))
  AND ("leaseExpiresAt" IS NULL OR "leaseExpiresAt"<="operationDeadlineAt")
  AND (("deliveryInputEncrypted" IS NULL)=("deliveryInputHash" IS NULL))
  AND (("deliveryInputEncrypted" IS NULL)=("deliveryContextFingerprint" IS NULL))
  AND ("deliveryInputEncrypted" IS NULL OR octet_length("deliveryInputEncrypted")<=131072)
  AND ("deliveryInputHash" IS NULL OR "deliveryInputHash"~'^[a-f0-9]{64}$')
  AND ("deliveryContextFingerprint" IS NULL OR "deliveryContextFingerprint"~'^[a-f0-9]{64}$')
  AND ("submissionStartedAt" IS NULL OR "deliveryInputHash" IS NOT NULL)
 )
);
CREATE INDEX "GrantPauseNotificationLedger_recovery_cursor" ON "GrantPauseNotificationLedger"("deploymentEpoch","createdAt",id) WHERE status IN ('pending','claimed');
CREATE FUNCTION protect_grant_notification_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW."workspaceId",NEW."grantId",NEW."pauseEventId",NEW."grantRevision",NEW.reason,NEW."createdAt",NEW."operationDeadlineAt") IS DISTINCT FROM ROW(OLD.id,OLD."workspaceId",OLD."grantId",OLD."pauseEventId",OLD."grantRevision",OLD.reason,OLD."createdAt",OLD."operationDeadlineAt")
 OR NEW.generation<OLD.generation OR NEW."attemptCount"<OLD."attemptCount"
 OR OLD."deliveryInputEncrypted" IS NOT NULL AND ROW(NEW."deliveryInputEncrypted",NEW."deliveryInputHash",NEW."deliveryContextFingerprint") IS DISTINCT FROM ROW(OLD."deliveryInputEncrypted",OLD."deliveryInputHash",OLD."deliveryContextFingerprint")
 THEN RAISE EXCEPTION 'grant notification input is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "GrantPauseNotificationLedger_immutable_input" BEFORE UPDATE ON "GrantPauseNotificationLedger" FOR EACH ROW EXECUTE FUNCTION protect_grant_notification_input();
CREATE INDEX "GrantPauseNotificationLedger_terminal_cursor" ON "GrantPauseNotificationLedger"("createdAt",id) WHERE status IN ('sent','failed','skipped');

-- Pre-production replacement: shared mail ledger is the sole notice authority.
ALTER TABLE "StandingGrant" DROP COLUMN "pauseNoticePending", DROP COLUMN "pauseNoticeLeaseUntil";
CREATE INDEX "StandingGrant_active_authority_cursor" ON "StandingGrant"("createdAt",id) WHERE status='active';
