DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "User" u
    LEFT JOIN "Workspace" w ON w."personalOwnerUserId" = u.id
    WHERE w.id IS NULL
       OR w."pricingTier" IS DISTINCT FROM (
         CASE WHEN u."pricingTier" = 'starter'
           THEN 'creator'::"PricingTier"
           ELSE u."pricingTier"
         END
       )
       OR w."stripeCustomerId" IS DISTINCT FROM u."stripeCustomerId"
       OR w."billingEventCreatedAt" IS DISTINCT FROM u."billingEventCreatedAt"
  ) THEN
    RAISE EXCEPTION 'Workspace billing cutover rejected inconsistent personal Workspace billing data';
  END IF;

  IF EXISTS (SELECT 1 FROM "Project" WHERE "workspaceId" IS NULL) THEN
    RAISE EXCEPTION 'Workspace billing cutover rejected Project rows without Workspace ownership';
  END IF;
END $$;

DROP INDEX IF EXISTS "User_stripeCustomerId_key";

ALTER TABLE "User"
  DROP COLUMN "pricingTier",
  DROP COLUMN "stripeCustomerId",
  DROP COLUMN "billingEventCreatedAt";

ALTER TABLE "Project" ALTER COLUMN "workspaceId" SET NOT NULL;
