-- One account owns a bounded rotating-token exchange. No SQL transaction
-- remains open over provider I/O, and unknown started exchanges need reconnect.
ALTER TABLE "SocialAccount" ADD COLUMN "tokenRefreshOwner" UUID,
 ADD COLUMN "tokenRefreshLeaseExpiresAt" TIMESTAMP(3),
 ADD COLUMN "tokenRefreshStartedAt" TIMESTAMP(3);
ALTER TABLE "SocialAccount" ADD CONSTRAINT "SocialAccount_token_refresh_shape" CHECK (
 ("tokenRefreshOwner" IS NULL AND "tokenRefreshLeaseExpiresAt" IS NULL AND "tokenRefreshStartedAt" IS NULL)
 OR ("tokenRefreshOwner" IS NOT NULL AND "tokenRefreshLeaseExpiresAt" IS NOT NULL
  AND ("tokenRefreshStartedAt" IS NULL OR "tokenRefreshStartedAt"<="tokenRefreshLeaseExpiresAt"))
);
CREATE FUNCTION social_token_refresh_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."tokenRefreshOwner" IS DISTINCT FROM OLD."tokenRefreshOwner" AND NEW."tokenRefreshOwner" IS NOT NULL AND OLD."tokenRefreshOwner" IS NOT NULL
  AND (OLD."tokenRefreshStartedAt" IS NOT NULL OR OLD."tokenRefreshLeaseExpiresAt">clock_timestamp() AT TIME ZONE 'UTC') THEN
  RAISE EXCEPTION 'active or uncertain token refresh cannot be replaced' USING ERRCODE='23514';
 END IF;
 IF OLD."tokenRefreshStartedAt" IS NOT NULL AND NEW."tokenRefreshOwner"=OLD."tokenRefreshOwner"
  AND NEW."tokenRefreshStartedAt" IS DISTINCT FROM OLD."tokenRefreshStartedAt" THEN
  RAISE EXCEPTION 'token refresh already started' USING ERRCODE='23514';
 END IF;
 IF OLD."tokenRefreshStartedAt" IS NOT NULL AND NEW."tokenRefreshOwner" IS NULL AND NEW."status"<>'revoked'
  AND (NEW."accessTokenEncrypted",NEW."refreshTokenEncrypted") IS NOT DISTINCT FROM (OLD."accessTokenEncrypted",OLD."refreshTokenEncrypted") THEN
  RAISE EXCEPTION 'started refresh needs replacement credentials or revocation' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "SocialAccount_token_refresh_fence" BEFORE UPDATE ON "SocialAccount"
 FOR EACH ROW EXECUTE FUNCTION social_token_refresh_fence();
