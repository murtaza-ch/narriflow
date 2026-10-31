import { lstat,readFile,realpath } from "node:fs/promises";
import { dirname,isAbsolute,join } from "node:path";
import { Readable } from "node:stream";
import { exportBundleExecutionInputSchema } from "@narriflow/validators/export-bundle-execution";
import { encodeExportBundleInput } from "@narriflow/services/export-bundle-input";
import { createExportBundleArchive,hashFile } from "./tasks/export-bundle";

const invalid=():never=>{throw Error("export_bundle_command_invalid");};
async function main(){
  const chunks:Buffer[]=[];let length=0;
  for await(const chunk of process.stdin){length+=chunk.length;if(length>65536)invalid();chunks.push(chunk);}
  const command=JSON.parse(Buffer.concat(chunks).toString("utf8"));
  if(!command||typeof command!=="object"||Object.keys(command).sort().join(",")!=="inputPath,sourceBaseUrl,work")invalid();
  for(const key of ["inputPath","work"])if(typeof command[key]!=="string"||command[key].length>4096||!isAbsolute(command[key]))invalid();
  if(typeof command.sourceBaseUrl!=="string"||command.sourceBaseUrl.length>512)invalid();
  const base=new URL(command.sourceBaseUrl);
  if(base.protocol!=="http:"||base.hostname!=="127.0.0.1"||!base.port||base.username||base.password||base.search||base.hash||!/^\/[A-Za-z0-9_-]+\/$/.test(base.pathname))invalid();
  const [work,path,info]=await Promise.all([realpath(command.work),realpath(command.inputPath),lstat(command.inputPath)]);
  if(info.isSymbolicLink()||!info.isFile()||info.size<1||info.size>16*1024**2||dirname(path)!==work)invalid();
  const input=exportBundleExecutionInputSchema.parse(JSON.parse(await readFile(path,"utf8")));
  await encodeExportBundleInput(input);
  const controller=new AbortController(),cancel=()=>controller.abort(Error("export_bundle_cancelled"));
  process.once("SIGTERM",cancel);process.once("SIGINT",cancel);const timer=setTimeout(cancel,45*60_000);
  try{
    const outputPath=join(work,"bundle.zip");
    const files=input.manifest.included.flatMap(item=>item.files).map(entry=>{
      const source=input.sources.find(source=>source.variantId===entry.variantId)!;
      return {name:entry.name,sha256:source.object.sha256,open:async()=>{
        const response=await fetch(new URL(source.name,base),{redirect:"error",signal:controller.signal});
        if(response.status!==200||response.headers.get("ETag")!==source.object.etag||response.headers.get("Content-Length")!==String(source.object.byteLength)||!response.body){await response.body?.cancel();throw Error("export_bundle_source_changed");}
        const reader=response.body.getReader();
        return Readable.from((async function*(){
          try{while(true){const result=await reader.read();if(result.done)break;yield result.value;}}
          finally{await reader.cancel().catch(()=>{});}
        })());
      }};
    });
    const info=await createExportBundleArchive({outputPath,manifest:input.manifest,files,signal:controller.signal});
    process.stdout.write(JSON.stringify({path:outputPath,byteLength:info.size,sha256:await hashFile(outputPath)})+"\n");
  }finally{clearTimeout(timer);process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);}
}
if(import.meta.main)main().catch((error:unknown)=>{
  const code=error instanceof Error&&/^export_bundle_[a-z_]+$/.test(error.message)?error.message:"export_bundle_process_failed";
  console.error(JSON.stringify({level:"error",message:"export_bundle_failed",errorCode:code}));process.exitCode=1;
});
