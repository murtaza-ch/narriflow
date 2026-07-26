-- ContentAsset: repurposed text outputs generated from a project's transcript

CREATE TABLE "ContentAsset" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "type" "OutputType" NOT NULL,
  "title" TEXT NOT NULL,
  "body" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "ContentAsset_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ContentAsset_projectId_type_key" ON "ContentAsset"("projectId", "type");
CREATE INDEX "ContentAsset_projectId_createdAt_idx" ON "ContentAsset"("projectId", "createdAt");

ALTER TABLE "ContentAsset"
  ADD CONSTRAINT "ContentAsset_projectId_fkey"
    FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
