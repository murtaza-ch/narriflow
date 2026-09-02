ALTER TABLE "AssistedCopyGeneration"
  ADD CONSTRAINT "AssistedCopyGeneration_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AssistedCopyGeneration"
  ADD CONSTRAINT "AssistedCopyGeneration_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AssistedCopyVariant"
  ADD CONSTRAINT "AssistedCopyVariant_confirmedByUserId_fkey"
  FOREIGN KEY ("confirmedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "ThumbnailFrameOperation"
  ADD CONSTRAINT "ThumbnailFrameOperation_workspaceId_fkey"
  FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ThumbnailFrameOperation"
  ADD CONSTRAINT "ThumbnailFrameOperation_createdByUserId_fkey"
  FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
