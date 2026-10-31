import { constants } from "node:fs";
import { open,writeFile } from "node:fs/promises";
import { z } from "zod";
import { signedNotificationCommandSchema, NOTIFICATION_BODY_MAX_BYTES } from "@narriflow/validators/outbound-delivery";
import { deliverSignedNotification } from "./callback-delivery";
const inputSchema=z.strictObject({command:signedNotificationCommandSchema,bodyPath:z.string().min(1).max(4096),outputPath:z.string().min(1).max(4096)});
async function main(){
 const chunks:Buffer[]=[];let size=0;
 for await(const chunk of process.stdin){size+=chunk.length;if(size>65536)throw new Error("outbound_command_invalid");chunks.push(chunk);}
 const input=inputSchema.parse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
 const handle=await open(input.bodyPath,constants.O_RDONLY|constants.O_NOFOLLOW);
 let body:Buffer;
 try{const info=await handle.stat();if(!info.isFile()||info.size!==input.command.body.byteLength||info.size>NOTIFICATION_BODY_MAX_BYTES)throw new Error("outbound_body_invalid");const parts:Buffer[]=[];let length=0;for await(const part of handle.createReadStream({autoClose:false,highWaterMark:65536})){const bytes=Buffer.isBuffer(part)?part:Buffer.from(part);length+=bytes.length;if(length>input.command.body.byteLength||length>NOTIFICATION_BODY_MAX_BYTES)throw new Error("outbound_body_invalid");parts.push(bytes);}body=Buffer.concat(parts);}finally{await handle.close();}
 const controller=new AbortController(),cancel=()=>controller.abort(new Error("outbound_cancelled"));
 process.once("SIGTERM",cancel);process.once("SIGINT",cancel);const timer=setTimeout(cancel,30000);
 try{const receipt=await deliverSignedNotification(input.command,body,{signal:controller.signal});await writeFile(input.outputPath,JSON.stringify(receipt),{flag:"wx",mode:0o600});process.stdout.write(`${JSON.stringify({completed:true})}\n`);}
 finally{clearTimeout(timer);process.removeListener("SIGTERM",cancel);process.removeListener("SIGINT",cancel);}
}
if(import.meta.main)main().catch(error=>{const code=error instanceof Error&&/^outbound_[a-z_]{1,64}$/.test(error.message)?error.message:"outbound_delivery_failed";console.error(JSON.stringify({level:"error",message:"outbound_delivery_failed",errorCode:code}));process.exitCode=1;});
