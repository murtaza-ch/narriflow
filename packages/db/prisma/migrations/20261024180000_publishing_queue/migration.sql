-- Publishing Queue: weekly posting slots on each Social Account, and proposals
-- that wait in the draft status until a person accepts them into a slot.

-- CreateEnum
CREATE TYPE "SocialPostProposalSource" AS ENUM ('person', 'integration', 'finishing');

-- AlterTable
ALTER TABLE "SocialAccount" ADD COLUMN     "postingSchedule" JSONB;

-- CreateTable
CREATE TABLE "SocialPostProposal" (
    "socialPostId" UUID NOT NULL,
    "source" "SocialPostProposalSource" NOT NULL,
    "clipExportVariantId" UUID NOT NULL,
    "assistedCopyVariantId" UUID,
    "title" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "acceptedByUserId" UUID,

    CONSTRAINT "SocialPostProposal_pkey" PRIMARY KEY ("socialPostId")
);

-- CreateIndex
CREATE INDEX "SocialPostProposal_clipExportVariantId_idx" ON "SocialPostProposal"("clipExportVariantId");

-- CreateIndex
CREATE INDEX "SocialPostProposal_assistedCopyVariantId_idx" ON "SocialPostProposal"("assistedCopyVariantId");

-- CreateIndex
CREATE INDEX "SocialPost_socialAccountId_scheduledFor_idx" ON "SocialPost"("socialAccountId", "scheduledFor");

-- AddForeignKey
ALTER TABLE "SocialPostProposal" ADD CONSTRAINT "SocialPostProposal_socialPostId_fkey" FOREIGN KEY ("socialPostId") REFERENCES "SocialPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostProposal" ADD CONSTRAINT "SocialPostProposal_clipExportVariantId_fkey" FOREIGN KEY ("clipExportVariantId") REFERENCES "ClipExportVariant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SocialPostProposal" ADD CONSTRAINT "SocialPostProposal_assistedCopyVariantId_fkey" FOREIGN KEY ("assistedCopyVariantId") REFERENCES "AssistedCopyVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;
