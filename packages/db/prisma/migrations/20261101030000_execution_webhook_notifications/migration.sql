ALTER TABLE "WebhookSubscription" ADD COLUMN "disableRevision" INTEGER NOT NULL DEFAULT 0 CHECK ("disableRevision">=0);
CREATE TABLE "WebhookDisabledNotificationLedger" (
 id UUID PRIMARY KEY,"workspaceId" UUID NOT NULL REFERENCES "Workspace"(id) ON DELETE CASCADE,
 "webhookId" UUID NOT NULL REFERENCES "WebhookSubscription"(id) ON DELETE CASCADE,
 "disableRevision" INTEGER NOT NULL,reason TEXT NOT NULL,"urlHost" TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',
 "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,generation INTEGER NOT NULL DEFAULT 1,"claimToken" UUID,
 "operationDeadlineAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '23 hours'),
 "deliveryInputEncrypted" TEXT,"deliveryInputHash" TEXT,"deliveryContextFingerprint" TEXT,
 "submissionStartedAt" TIMESTAMP(3),"leaseExpiresAt" TIMESTAMP(3),"attemptCount" INTEGER NOT NULL DEFAULT 0,
 "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"failureCode" TEXT,"providerMessageId" TEXT,"sentAt" TIMESTAMP(3),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,"updatedAt" TIMESTAMP(3) NOT NULL,
 UNIQUE("webhookId","disableRevision"),
 CONSTRAINT "WebhookDisabledNotification_execution_shape" CHECK (
  "deploymentEpoch">0 AND generation>0 AND "disableRevision">0 AND "attemptCount" BETWEEN 0 AND 3
  AND status IN ('pending','claimed','sent','failed','skipped')
  AND reason IN ('consecutive_failures','cursor_expired','endpoint_gone','delivery_attempts_exhausted') AND octet_length("urlHost") BETWEEN 1 AND 253
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
CREATE INDEX "WebhookDisabledNotificationLedger_recovery_cursor" ON "WebhookDisabledNotificationLedger"("deploymentEpoch","createdAt",id) WHERE status IN ('pending','claimed');
CREATE FUNCTION protect_webhook_notification_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF ROW(NEW.id,NEW."workspaceId",NEW."webhookId",NEW."disableRevision",NEW.reason,NEW."urlHost",NEW."createdAt",NEW."operationDeadlineAt") IS DISTINCT FROM ROW(OLD.id,OLD."workspaceId",OLD."webhookId",OLD."disableRevision",OLD.reason,OLD."urlHost",OLD."createdAt",OLD."operationDeadlineAt")
 OR NEW.generation<OLD.generation OR NEW."attemptCount"<OLD."attemptCount"
 OR OLD."deliveryInputEncrypted" IS NOT NULL AND ROW(NEW."deliveryInputEncrypted",NEW."deliveryInputHash",NEW."deliveryContextFingerprint") IS DISTINCT FROM ROW(OLD."deliveryInputEncrypted",OLD."deliveryInputHash",OLD."deliveryContextFingerprint")
 THEN RAISE EXCEPTION 'webhook notification input is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WebhookDisabledNotificationLedger_immutable_input" BEFORE UPDATE ON "WebhookDisabledNotificationLedger" FOR EACH ROW EXECUTE FUNCTION protect_webhook_notification_input();
CREATE INDEX "WebhookDisabledNotificationLedger_terminal_cursor" ON "WebhookDisabledNotificationLedger"("createdAt",id) WHERE status IN ('sent','failed','skipped');

-- Existing pre-production disabled rows retain their original bounded notice
-- lifetime; terminal or expired ones are handled by the same exact mail driver.
UPDATE "WebhookSubscription" SET "disableRevision"=1 WHERE status='disabled';
INSERT INTO "WebhookDisabledNotificationLedger" (id,"workspaceId","webhookId","disableRevision",reason,"urlHost","deploymentEpoch","createdAt","updatedAt","nextAttemptAt","operationDeadlineAt")
SELECT gen_random_uuid(),w."workspaceId",w.id,1,w."disabledReason",w."urlHost",e.epoch,COALESCE(w."disabledAt",CURRENT_TIMESTAMP),CURRENT_TIMESTAMP,COALESCE(w."disabledAt",CURRENT_TIMESTAMP),COALESCE(w."disabledAt",CURRENT_TIMESTAMP)+INTERVAL '23 hours'
FROM "WebhookSubscription" w CROSS JOIN "ExecutionEpoch" e WHERE w.status='disabled' AND w."disabledReason" IS NOT NULL AND e.id=1;
ALTER TABLE "WebhookSubscription" DROP COLUMN "disabledNotifiedAt";
CREATE FUNCTION protect_webhook_disable_revision() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."disableRevision"<OLD."disableRevision" OR NEW."disableRevision"<>OLD."disableRevision" AND NOT(OLD.status='active' AND NEW.status='disabled' AND NEW."disableRevision"=OLD."disableRevision"+1)
 OR OLD.status='active' AND NEW.status='disabled' AND NEW."disableRevision"<>OLD."disableRevision"+1
 THEN RAISE EXCEPTION 'webhook disable revision is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "WebhookSubscription_disable_revision" BEFORE UPDATE ON "WebhookSubscription" FOR EACH ROW EXECUTE FUNCTION protect_webhook_disable_revision();
