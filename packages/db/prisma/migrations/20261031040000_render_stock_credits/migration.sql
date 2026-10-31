ALTER TABLE "ClipRender" ADD COLUMN "brollCredits" JSONB;
ALTER TABLE "ClipRender" ADD CONSTRAINT "clip_render_stock_credits_bounded"
  CHECK ("brollCredits" IS NULL OR (
    jsonb_typeof("brollCredits") = 'array' AND jsonb_array_length("brollCredits") BETWEEN 1 AND 6
    AND octet_length("brollCredits"::text) <= 65536
  ));
