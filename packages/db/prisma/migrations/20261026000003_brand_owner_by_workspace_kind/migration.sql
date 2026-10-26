-- Branding ownership follows the Workspace kind, not its plan: a personal
-- Workspace's Brand Profiles, fonts, and Visual Assets belong to its owner,
-- and a collaborative Workspace's belong to the Workspace. The old rule made a
-- personal Workspace on Business own them as a Workspace, so rows created then
-- move to the personal owner here. Scene Templates belong to their Brand
-- Profile and move with it. Brand Templates were always Workspace-scoped and
-- do not move. The Workspace's default Brand Profile moves to its owner.

-- A moved font or asset whose content the owner already holds cannot be merged
-- without rewriting saved documents that reference either row. Stop instead.
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT
    (SELECT count(*)
       FROM "BrandFont" moved
       JOIN "Workspace" w ON w."id" = moved."workspaceId" AND w."personalOwnerUserId" IS NOT NULL
       JOIN "BrandFont" kept ON kept."userId" = w."personalOwnerUserId" AND kept."fingerprint" = moved."fingerprint")
    +
    (SELECT count(*)
       FROM "VisualAsset" moved
       JOIN "Workspace" w ON w."id" = moved."workspaceId" AND w."personalOwnerUserId" IS NOT NULL
       JOIN "VisualAsset" kept ON kept."userId" = w."personalOwnerUserId" AND kept."fingerprint" = moved."fingerprint")
  INTO collisions;
  IF collisions > 0 THEN
    RAISE EXCEPTION 'brand_owner_by_workspace_kind: % personal-Workspace font/asset row(s) duplicate one the owner already has; resolve them before migrating', collisions;
  END IF;
END $$;

-- Keep slugs unique for the owner by suffixing a moved profile's slug with its id.
UPDATE "BrandProfile" AS moved
SET "slug" = left(moved."slug", 71) || '-' || left(moved."id"::text, 8)
FROM "Workspace" w
WHERE w."id" = moved."workspaceId"
  AND w."personalOwnerUserId" IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM "BrandProfile" kept
    WHERE kept."userId" = w."personalOwnerUserId" AND kept."slug" = moved."slug"
  );

UPDATE "BrandProfile" AS p
SET "userId" = w."personalOwnerUserId", "workspaceId" = NULL
FROM "Workspace" w
WHERE w."id" = p."workspaceId" AND w."personalOwnerUserId" IS NOT NULL;

UPDATE "BrandFont" AS f
SET "userId" = w."personalOwnerUserId", "workspaceId" = NULL
FROM "Workspace" w
WHERE w."id" = f."workspaceId" AND w."personalOwnerUserId" IS NOT NULL;

UPDATE "VisualAsset" AS a
SET "userId" = w."personalOwnerUserId", "workspaceId" = NULL
FROM "Workspace" w
WHERE w."id" = a."workspaceId" AND w."personalOwnerUserId" IS NOT NULL;

-- The Workspace default was the one in use while it was on Business; it wins
-- there, and fills an empty owner default otherwise.
UPDATE "User" AS u
SET "defaultBrandProfileId" = w."defaultBrandProfileId"
FROM "Workspace" w
WHERE w."personalOwnerUserId" = u."id"
  AND w."defaultBrandProfileId" IS NOT NULL
  AND (u."defaultBrandProfileId" IS NULL OR w."pricingTier" = 'business');

UPDATE "Workspace"
SET "defaultBrandProfileId" = NULL
WHERE "personalOwnerUserId" IS NOT NULL AND "defaultBrandProfileId" IS NOT NULL;
