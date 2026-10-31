import { createHash } from "node:crypto";
import { signedNotificationCommandSchema, type SignedNotificationCommand, type NotificationReceipt } from "@narriflow/validators/outbound-delivery";
import { guardedFetch, RemoteFetchError, UnsafeUrlError, type PinnedTransport, type HostResolver } from "./outbound-transport";

/** The Worker signed this exact body. Native code owns only one finite POST;
 * it cannot choose another method, caller headers, redirects or signing key. */
export async function deliverSignedNotification(raw:SignedNotificationCommand,body:Uint8Array,options:{transport?:PinnedTransport;resolver?:HostResolver;signal?:AbortSignal;nowSeconds?:number}={}):Promise<NotificationReceipt>{
 const command=signedNotificationCommandSchema.parse(raw);
 if(body.length!==command.body.byteLength||createHash("sha256").update(body).digest("hex")!==command.body.sha256)throw new Error("outbound_body_invalid");
 let identity:unknown;
 try{identity=JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(body));}catch{throw new Error("outbound_body_invalid");}
 if(!identity||typeof identity!=="object"||Array.isArray(identity)||(identity as {id?:unknown}).id!==command.eventId||(identity as {workspaceId?:unknown}).workspaceId!==command.workspaceId)throw new Error("outbound_body_invalid");
 const timestamp=Number(command.headers["webhook-timestamp"]),now=options.nowSeconds??Math.floor(Date.now()/1000);
 if(Math.abs(now-timestamp)>120)throw new Error("outbound_signature_expired");
 const started=performance.now();let status:number|null=null,errorCode:NotificationReceipt["errorCode"]=null;
 try{
  const response=await guardedFetch(command.url,{method:"POST",body,headers:command.headers,timeoutMs:10000,maxRedirects:0,transport:options.transport,resolver:options.resolver,signal:options.signal});
  status=response.status;
  await response.body?.cancel().catch(()=>undefined);
 }catch(error){options.signal?.throwIfAborted();errorCode=error instanceof RemoteFetchError||error instanceof UnsafeUrlError?error.code:"remote_download_failed";}
 return {version:1,kind:"signed_notification",deliveryId:command.deliveryId,eventId:command.eventId,workspaceId:command.workspaceId,inputHash:command.inputHash,bodySha256:command.body.sha256,status,durationMs:Math.max(0,Math.round(performance.now()-started)),errorCode};
}
