import { isAbsolute } from "node:path";
import { z } from "zod";
import { ingestDirectReadSchema } from "@narriflow/validators/execution";
import { DirectSourceFailure,downloadDirectSource } from "./direct-source";
const schema=z.strictObject({source:ingestDirectReadSchema,outputPath:z.string().min(1).max(4096).refine(value=>isAbsolute(value)&&!value.includes("\0")),deadlineMs:z.number().int().positive().max(45*60_000)});
async function main(){
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw new DirectSourceFailure("worker_invalid_payload");chunks.push(chunk);}
 const input=schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
 const controller=new AbortController(),cancel=()=>controller.abort(new DirectSourceFailure("remote_fetch_timeout",true));
 process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
 try{const result=await downloadDirectSource(input.source,input.outputPath,{signal:controller.signal,deadlineMs:input.deadlineMs});process.stdout.write(JSON.stringify(result)+"\n");}
 finally{process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);}
}
if(import.meta.main)main().catch(error=>{const known=error instanceof DirectSourceFailure;console.error(JSON.stringify({level:"error",message:"source_download_failed",errorCode:known?error.code:"worker_invalid_payload",retryable:known&&error.retryable}));process.exitCode=1;});
