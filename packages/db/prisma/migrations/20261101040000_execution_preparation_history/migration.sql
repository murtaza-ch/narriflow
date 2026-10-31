-- A preparation is immutable execution history, as is its RenderGroup. Clip
-- replacement retires the live projection; Project privacy deletion still
-- cascades both histories together through their existing Project/Run FKs.
ALTER TABLE "ClipPreparation" DROP CONSTRAINT "ClipPreparation_clipId_projectId_fkey";
CREATE FUNCTION guard_clip_preparation_admission_lineage() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM "Clip" WHERE id=NEW."clipId" AND "projectId"=NEW."projectId" FOR KEY SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Clip preparation admission requires a live Clip in the same Project'
      USING ERRCODE='23503', CONSTRAINT='ClipPreparation_live_clip_at_admission';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "ClipPreparation_admission_lineage" BEFORE INSERT ON "ClipPreparation"
 FOR EACH ROW EXECUTE FUNCTION guard_clip_preparation_admission_lineage();
