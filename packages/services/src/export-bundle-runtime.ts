import { getPrismaClient } from "@narriflow/db/client";
import { ExportBundleExecution } from "./export-bundle-execution";
import { getPrivateJsonStorage } from "./clip-preparation-runtime";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { readServiceEnvironment } from "./runtime-environment";
import type { ExportBundleExecutionInput } from "@narriflow/validators/export-bundle-execution";

/** Every command receives a fresh database, environment and bucket HEAD port. */
export function getExportBundleExecution(head:(storageKey:string)=>Promise<ExportBundleExecutionInput["sources"][number]["object"]|null>){
  const database=getPrismaClient();if(!database)throw Error("Export Bundle execution requires a database scope");
  return new ExportBundleExecution(database,{toolchainFingerprint:readServiceEnvironment().MEDIA_FETCH_TOOLCHAIN_FINGERPRINT??'',inputStorage:getPrivateJsonStorage(),register:deliverExecutionDispatches,
    head:async storageKey=>{
      const object=await head(storageKey);if(!object||object.storageKey!==storageKey)return null;
      if(object.sha256)return object;
      const committed=await database.executionArtifact.findFirst({where:{storageKey,etag:object.etag,byteLength:BigInt(object.byteLength),committedAt:{not:null}},select:{checksumSha256:true}});
      return committed?.checksumSha256?{...object,sha256:committed.checksumSha256}:object;
    }});
}
