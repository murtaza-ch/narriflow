import { AsyncLocalStorage } from "node:async_hooks";
import { getPrismaClient } from "@narriflow/db/client";
import { headObject } from "./r2-storage";
import { NativeValidationError, NativeValidationService } from "./native-validation";

const scheduling = new AsyncLocalStorage<{ register(ids: readonly string[]): Promise<void> }>();
export function withNativeValidationScheduler<T>(port: { register(ids: readonly string[]): Promise<void> }, operation: () => T): T { return scheduling.run(port, operation); }
export function getNativeValidationService() {
  const db = getPrismaClient();
  if (!db) throw new NativeValidationError("native_validation_unavailable");
  return new NativeValidationService(db, { head: async key => {
    const object = await headObject(key);
    if (!object.etag) throw new NativeValidationError("native_validation_object_invalid");
    return { ...object, etag: object.etag };
  }, register: async ids => {
    const port = scheduling.getStore();
    if (!port) throw new NativeValidationError("native_validation_unavailable");
    await port.register(ids);
  } });
}
