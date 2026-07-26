-- AlterTable: per-clip stock B-roll override chosen in the studio picker.
-- Additive + nullable, so it is backward-compatible with existing rows.
ALTER TABLE "Clip" ADD COLUMN "brollUrl" TEXT;
