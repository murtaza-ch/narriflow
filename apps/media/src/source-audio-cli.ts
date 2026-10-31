import { isAbsolute,dirname } from "node:path";
import { lstat,stat } from "node:fs/promises";
import { z } from "zod";
import { createWorkerProcessModule } from "./worker-process";
import { extractTranscriptionAudio } from "./tasks/extract-audio";
const path=z.string().min(1).max(4096).refine(value=>isAbsolute(value)&&!value.includes("\0"));
const schema=z.strictObject({sourcePath:path,outputPath:path,audioStreamIndex:z.number().int().nonnegative().max(1024),deadlineMs:z.number().int().positive().max(45*60_000)});
async function main(){
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw new Error("source_audio_invalid");chunks.push(chunk);}
 const input=schema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
 const source=await lstat(input.sourcePath);
 if(!source.isFile()||source.isSymbolicLink()||source.size<=0||source.size>10*1024**3||dirname(input.sourcePath)!==dirname(input.outputPath)||await lstat(input.outputPath).then(()=>true,()=>false))throw new Error("source_audio_invalid");
 const controller=new AbortController(),cancel=()=>controller.abort(new Error("media_execution_cancelled"));
 process.once("SIGTERM",cancel);process.once("SIGINT",cancel);
 try{await extractTranscriptionAudio({...input,workerProcess:createWorkerProcessModule(),signal:controller.signal,localOnly:true});
  const result=await stat(input.outputPath);if(!result.isFile()||result.size<=0||result.size>2*1024**3)throw new Error("source_audio_invalid");
  process.stdout.write(JSON.stringify({byteLength:result.size})+"\n");
 }finally{process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);}
}
if(import.meta.main)main().catch(()=>{console.error(JSON.stringify({level:"error",message:"source_audio_failed",errorCode:"source_audio_failed"}));process.exitCode=1;});
