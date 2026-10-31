ALTER TYPE "DubStatus" ADD VALUE 'unknown';

CREATE FUNCTION protect_unknown_dub_outcome() RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status::text='unknown' AND (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt') THEN
    RAISE EXCEPTION 'Unknown paid dubbing outcome is immutable' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ClipDub_unknown_immutable" BEFORE UPDATE ON "ClipDub" FOR EACH ROW EXECUTE FUNCTION protect_unknown_dub_outcome();
