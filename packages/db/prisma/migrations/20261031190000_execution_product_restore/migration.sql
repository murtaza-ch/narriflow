CREATE FUNCTION protect_export_bundle_accepted_deadline() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."operationDeadlineAt" IS DISTINCT FROM OLD."operationDeadlineAt" THEN
    RAISE EXCEPTION 'Export Bundle accepted deadline is immutable across restore' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ExportBundle_accepted_deadline_immutable" BEFORE UPDATE ON "ExportBundle" FOR EACH ROW EXECUTE FUNCTION protect_export_bundle_accepted_deadline();
CREATE INDEX "ExportBundle_restore_active_page_idx" ON "ExportBundle"("createdAt",id) WHERE status IN ('queued','building');
CREATE INDEX "ClipDub_restore_active_page_idx" ON "ClipDub"("createdAt",id) WHERE status IN ('queued','processing') AND "workflowRunId" IS NOT NULL AND "frozenRequest" IS NOT NULL;
