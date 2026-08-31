-- Transactional, exactly-once program-measure events. Deterministic event IDs
-- make repeated terminal updates harmless without adding a second ledger.

CREATE FUNCTION "emit_program_workflow_analytics"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
BEGIN
  IF NEW."stage" = 'clip_rendering'
     AND NEW."status" IN ('completed', 'partial')
     AND COALESCE(NEW."succeededCount", 0) > 0 THEN
    INSERT INTO "ProjectAnalyticsEvent" (
      "id",
      "projectId",
      "clipId",
      "type",
      "platform",
      "metadata",
      "createdAt"
    ) VALUES (
      md5('clips_ready:' || NEW."id"::text)::uuid,
      NEW."projectId",
      NULL,
      'clips_ready'::"AnalyticsEventType",
      NULL,
      jsonb_build_object(
        'featureVersion', 'approved-campaign-v1',
        'selectedCount', COALESCE(NEW."requestedCount", NEW."succeededCount"),
        'requestedCount', COALESCE(NEW."requestedCount", NEW."succeededCount"),
        'succeededCount', NEW."succeededCount",
        'failedCount', COALESCE(NEW."failedCount", 0),
        'outcome', NEW."status"
      ),
      CURRENT_TIMESTAMP
    )
    ON CONFLICT ("id") DO NOTHING;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "WorkflowRun_program_analytics"
AFTER INSERT OR UPDATE OF "stage", "status", "requestedCount", "succeededCount", "failedCount"
ON "WorkflowRun"
FOR EACH ROW
EXECUTE FUNCTION "emit_program_workflow_analytics"();

CREATE FUNCTION "emit_program_campaign_operation_analytics"()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path FROM CURRENT
AS $$
DECLARE
  approval_override_count INTEGER;
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "ProjectAnalyticsEvent" (
      "id",
      "projectId",
      "clipId",
      "type",
      "platform",
      "metadata",
      "createdAt"
    ) VALUES (
      md5('campaign_operation_started:' || NEW."id"::text)::uuid,
      NEW."projectId",
      NULL,
      'campaign_operation_started'::"AnalyticsEventType",
      NULL,
      jsonb_build_object(
        'campaignOperationId', NEW."id",
        'kind', NEW."action",
        'selectedCount', NEW."requestedCount",
        'requestedCount', NEW."requestedCount",
        'outcome', NEW."status",
        'featureVersion', 'approved-campaign-v1'
      ),
      NEW."createdAt"
    )
    ON CONFLICT ("id") DO NOTHING;
  END IF;

  IF NEW."status" IN ('completed', 'partial', 'failed') THEN
    INSERT INTO "ProjectAnalyticsEvent" (
      "id",
      "projectId",
      "clipId",
      "type",
      "platform",
      "metadata",
      "createdAt"
    ) VALUES (
      md5('campaign_operation_completed:' || NEW."id"::text)::uuid,
      NEW."projectId",
      NULL,
      'campaign_operation_completed'::"AnalyticsEventType",
      NULL,
      jsonb_build_object(
        'campaignOperationId', NEW."id",
        'kind', NEW."action",
        'selectedCount', NEW."requestedCount",
        'requestedCount', NEW."requestedCount",
        'succeededCount', NEW."succeededCount",
        'unchangedCount', NEW."unchangedCount",
        'staleCount', NEW."staleCount",
        'ineligibleCount', NEW."ineligibleCount",
        'failedCount', NEW."failedCount",
        'outcome', NEW."status",
        'featureVersion', 'approved-campaign-v1'
      ),
      COALESCE(NEW."completedAt", CURRENT_TIMESTAMP)
    )
    ON CONFLICT ("id") DO NOTHING;

    IF NEW."action" = 'bulk_schedule' AND NEW."succeededCount" > 0 THEN
      SELECT COUNT(*)::integer
      INTO approval_override_count
      FROM "CampaignOperationItem"
      WHERE "operationId" = NEW."id"
        AND "status" = 'succeeded'
        AND "reviewApprovalOverrideId" IS NOT NULL;

      INSERT INTO "ProjectAnalyticsEvent" (
        "id",
        "projectId",
        "clipId",
        "type",
        "platform",
        "metadata",
        "createdAt"
      ) VALUES (
        md5('campaign_scheduled:' || NEW."id"::text)::uuid,
        NEW."projectId",
        NULL,
        'campaign_scheduled'::"AnalyticsEventType",
        NULL,
        jsonb_build_object(
          'campaignOperationId', NEW."id",
          'selectedCount', NEW."requestedCount",
          'scheduledCount', NEW."succeededCount",
          'failedCount', NEW."failedCount",
          'approvalOverrides', COALESCE(approval_override_count, 0),
          'outcome', NEW."status",
          'featureVersion', 'approved-campaign-v1'
        ),
        COALESCE(NEW."completedAt", CURRENT_TIMESTAMP)
      )
      ON CONFLICT ("id") DO NOTHING;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "CampaignOperation_program_analytics"
AFTER INSERT OR UPDATE OF
  "status",
  "requestedCount",
  "succeededCount",
  "unchangedCount",
  "staleCount",
  "ineligibleCount",
  "failedCount",
  "completedAt"
ON "CampaignOperation"
FOR EACH ROW
EXECUTE FUNCTION "emit_program_campaign_operation_analytics"();
