-- Clip cleanup chosen at generation: silence and filler-word removal.
ALTER TABLE "ContentPack" ADD COLUMN "removeSilences" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ContentPack" ADD COLUMN "removeFillerWords" BOOLEAN NOT NULL DEFAULT false;

-- Quiet intervals measured on the transcription audio, as whole-centisecond
-- [gap, length, ...] run lengths (encodedQuietRangesSchema). Null: not measured.
ALTER TABLE "SourceAudio" ADD COLUMN "quietRanges" JSONB;
ALTER TABLE "SourceAudio" ADD CONSTRAINT "SourceAudio_quietRanges_array"
  CHECK ("quietRanges" IS NULL OR jsonb_typeof("quietRanges") = 'array');
