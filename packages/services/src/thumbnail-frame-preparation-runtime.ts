import { getPrismaClient } from "@narriflow/db/client";
import { ThumbnailFrameExecution, type ThumbnailFrameRequest } from "./thumbnail-frame-execution";
import { ThumbnailPreparationError } from "./thumbnail-frame-preparation";
import { headObject } from "./r2-storage";
import { registerNativeValidationDispatches } from "./native-validation-runtime";

export function getThumbnailFrameExecution() {
  const database = getPrismaClient();
  if (!database) throw new ThumbnailPreparationError("thumbnail_scheduling_unavailable");
  return new ThumbnailFrameExecution(database, {
    head: async key => { const object = await headObject(key); if (!object.etag) throw new ThumbnailPreparationError("thumbnail_source_missing"); return { ...object, etag: object.etag }; },
    register: registerNativeValidationDispatches,
  });
}

export class ThumbnailFramePreparationService {
  request(input: ThumbnailFrameRequest) { return getThumbnailFrameExecution().request(input); }
  get(workspaceId: string, projectId: string, id: string) { return getThumbnailFrameExecution().get(workspaceId, projectId, id); }
  retry(actorUserId: string, workspaceId: string, projectId: string, id: string) { return getThumbnailFrameExecution().retry(actorUserId, workspaceId, projectId, id); }
}
export const thumbnailFramePreparationService = new ThumbnailFramePreparationService();
