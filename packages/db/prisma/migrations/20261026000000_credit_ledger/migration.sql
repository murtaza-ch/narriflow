-- Processing Usage now debits whole credits: one credit is one started minute
-- of source video, stored as debit seconds in multiples of 60. Quantize the
-- existing pre-production rows once (any started minute becomes a credit),
-- then keep every future debit whole.
UPDATE "ProcessingUsageReservation"
SET
  "reservedSeconds" = (CEIL(GREATEST("reservedSeconds", 0) / 60.0) * 60)::int,
  "settledSeconds" = CASE
    WHEN "settledSeconds" IS NULL THEN NULL
    ELSE (CEIL(GREATEST("settledSeconds", 0) / 60.0) * 60)::int
  END
WHERE "reservedSeconds" % 60 <> 0
  OR "reservedSeconds" < 0
  OR ("settledSeconds" IS NOT NULL AND ("settledSeconds" % 60 <> 0 OR "settledSeconds" < 0));

ALTER TABLE "ProcessingUsageReservation"
  ADD CONSTRAINT "ProcessingUsageReservation_reservedSeconds_whole_credits"
  CHECK ("reservedSeconds" >= 0 AND "reservedSeconds" % 60 = 0);

ALTER TABLE "ProcessingUsageReservation"
  ADD CONSTRAINT "ProcessingUsageReservation_settledSeconds_whole_credits"
  CHECK ("settledSeconds" IS NULL OR ("settledSeconds" >= 0 AND "settledSeconds" % 60 = 0));
