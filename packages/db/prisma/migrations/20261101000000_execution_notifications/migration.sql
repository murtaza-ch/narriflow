ALTER TABLE "NotificationLedger"
 ADD COLUMN facts JSONB,
 ADD COLUMN "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN generation INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "claimToken" UUID,
 ADD COLUMN "operationDeadlineAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '23 hours'),
 ADD COLUMN "deliveryInputEncrypted" TEXT,
 ADD COLUMN "deliveryInputHash" TEXT,
 ADD COLUMN "submissionStartedAt" TIMESTAMP(3),
 ADD COLUMN "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 ADD COLUMN "failureCode" TEXT,
 ADD CONSTRAINT "NotificationLedger_execution_shape" CHECK ("deploymentEpoch">0 AND generation>0 AND "operationDeadlineAt">="createdAt" AND (("deliveryInputEncrypted" IS NULL)=("deliveryInputHash" IS NULL)));
ALTER TABLE "ReviewNotificationLedger"
 ADD COLUMN "deploymentEpoch" INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN generation INTEGER NOT NULL DEFAULT 1,
 ADD COLUMN "claimToken" UUID,
 ADD COLUMN "operationDeadlineAt" TIMESTAMP(3) NOT NULL DEFAULT (CURRENT_TIMESTAMP + INTERVAL '23 hours'),
 ADD COLUMN "deliveryInputEncrypted" TEXT,
 ADD COLUMN "deliveryInputHash" TEXT,
 ADD COLUMN "submissionStartedAt" TIMESTAMP(3),
 ADD CONSTRAINT "ReviewNotificationLedger_execution_shape" CHECK ("deploymentEpoch">0 AND generation>0 AND "operationDeadlineAt">="createdAt" AND (("deliveryInputEncrypted" IS NULL)=("deliveryInputHash" IS NULL)));
CREATE FUNCTION protect_notification_execution_input() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
 OR NEW."operationDeadlineAt" IS DISTINCT FROM OLD."operationDeadlineAt" OR NEW.generation<OLD.generation
 OR OLD."deliveryInputEncrypted" IS NOT NULL AND ROW(NEW."deliveryInputEncrypted",NEW."deliveryInputHash") IS DISTINCT FROM ROW(OLD."deliveryInputEncrypted",OLD."deliveryInputHash")
 OR TG_TABLE_NAME='NotificationLedger' AND (to_jsonb(NEW)->'facts',to_jsonb(NEW)->'projectId',to_jsonb(NEW)->'sourceId',to_jsonb(NEW)->'outcome') IS DISTINCT FROM (to_jsonb(OLD)->'facts',to_jsonb(OLD)->'projectId',to_jsonb(OLD)->'sourceId',to_jsonb(OLD)->'outcome')
 OR TG_TABLE_NAME='ReviewNotificationLedger' AND (to_jsonb(NEW)->'reviewRoundId',to_jsonb(NEW)->'recipientEmail',to_jsonb(NEW)->'kind',to_jsonb(NEW)->'scopeKey') IS DISTINCT FROM (to_jsonb(OLD)->'reviewRoundId',to_jsonb(OLD)->'recipientEmail',to_jsonb(OLD)->'kind',to_jsonb(OLD)->'scopeKey')
 THEN RAISE EXCEPTION 'notification delivery input is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER "NotificationLedger_immutable_input" BEFORE UPDATE ON "NotificationLedger" FOR EACH ROW EXECUTE FUNCTION protect_notification_execution_input();
CREATE TRIGGER "ReviewNotificationLedger_immutable_input" BEFORE UPDATE ON "ReviewNotificationLedger" FOR EACH ROW EXECUTE FUNCTION protect_notification_execution_input();
CREATE INDEX "NotificationLedger_recovery_cursor" ON "NotificationLedger" ("deploymentEpoch","createdAt",id) WHERE status IN ('pending','claimed');
CREATE INDEX "ReviewNotificationLedger_recovery_cursor" ON "ReviewNotificationLedger" ("deploymentEpoch","createdAt",id) WHERE status IN ('pending','claimed');
