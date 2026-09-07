-- PostgreSQL does not allow a newly added enum value to be used until the
-- transaction that introduced it commits. Keep this role/type transition in
-- its own migration so the ownership backfill can safely write `owner` rows.
ALTER TYPE "TeamRole" RENAME TO "WorkspaceRole";
ALTER TYPE "WorkspaceRole" ADD VALUE IF NOT EXISTS 'owner' BEFORE 'admin';
