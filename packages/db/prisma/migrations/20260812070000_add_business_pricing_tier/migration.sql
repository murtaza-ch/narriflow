-- Business is a workspace-owned paid tier. PostgreSQL enum values must be
-- committed before application writes can use them.
ALTER TYPE "PricingTier" ADD VALUE IF NOT EXISTS 'business' AFTER 'pro';
