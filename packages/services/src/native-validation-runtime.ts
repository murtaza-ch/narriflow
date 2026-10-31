import { getPrismaClient } from "@narriflow/db/client";
import { headObject } from "./r2-storage";
import { NativeValidationError, NativeValidationService } from "./native-validation";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";

export async function registerNativeValidationDispatches(ids: readonly string[]) {
  if (ids.length > 16) throw new NativeValidationError("native_validation_unavailable");
  await deliverExecutionDispatches(ids);
}
export function getNativeValidationService() {
  const db = getPrismaClient();
  if (!db) throw new NativeValidationError("native_validation_unavailable");
  return new NativeValidationService(db, { head: async key => {
    const object = await headObject(key);
    if (!object.etag) throw new NativeValidationError("native_validation_object_invalid");
    return { ...object, etag: object.etag };
  }, register: registerNativeValidationDispatches });
}
