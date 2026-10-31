import { expect,test } from "bun:test";
import { createHash } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { deliverSignedNotification } from "./callback-delivery";
import { generateCallbackSigningSecret,signCallback } from "@narriflow/services/completion-callback";
import type { SignedNotificationCommand } from "@narriflow/validators/outbound-delivery";
const eventId="60000000-0000-4000-8000-000000000001",workspaceId="60000000-0000-4000-8000-000000000002";
const body=new TextEncoder().encode(JSON.stringify({id:eventId,workspaceId,type:"webhook.test",subject:{}}));
const secret=generateCallbackSigningSecret(),timestamp=Math.floor(Date.now()/1000);
const command:SignedNotificationCommand={kind:"signed_notification",deliveryId:"60000000-0000-4000-8000-000000000003",eventId,workspaceId,inputHash:"a".repeat(64),url:"https://hooks.example/receive",body:{source:"notification_body",sha256:createHash("sha256").update(body).digest("hex"),byteLength:body.length},headers:{"content-type":"application/json","user-agent":"Narriflow-Callbacks/1","webhook-id":eventId,"webhook-timestamp":String(timestamp),"webhook-signature":signCallback({eventId,timestamp,body:new TextDecoder().decode(body),secrets:[secret]})}};
const resolver=async()=>[{address:"93.184.216.34",family:4}];
test("native sends the exact Worker-signed body through the pinned guard and discards the response body",async()=>{
 let calls=0,cancelled=false;
 const receipt=await deliverSignedNotification(command,body,{resolver,transport:async(url,request)=>{
  calls++;expect(url.href).toBe(command.url);expect(request.method).toBe("POST");expect(request.addresses).toEqual([{address:"93.184.216.34",family:4}]);
  const sent=new TextDecoder().decode(request.body as Uint8Array);
  expect(new Webhook(secret).verify(sent,Object.fromEntries(request.headers))).toMatchObject({id:eventId,workspaceId});
  expect(sent).toBe(new TextDecoder().decode(body));
  return new Response(new ReadableStream({cancel(){cancelled=true;}}),{status:202});
 }});
 expect(calls).toBe(1);expect(cancelled).toBe(true);expect(receipt).toMatchObject({status:202,errorCode:null,eventId,bodySha256:command.body.sha256,inputHash:command.inputHash});
});
test("a notification never follows redirects or sends to a private DNS answer",async()=>{
 let calls=0;
 const redirect=await deliverSignedNotification(command,body,{resolver,transport:async()=>{calls++;return new Response(null,{status:302,headers:{location:"https://127.0.0.1/private"}});}});
 expect(redirect.status).toBe(302);expect(calls).toBe(1);
 const unsafe=await deliverSignedNotification(command,body,{resolver:async()=>[{address:"93.184.216.34"},{address:"127.0.0.1"}],transport:async()=>{calls++;throw new Error("unreachable");}});
 expect(unsafe).toMatchObject({status:null,errorCode:"remote_url_unsafe"});expect(calls).toBe(1);
});
test("changed body bytes, another event identity or expired signatures stop before POST",async()=>{
 let calls=0;const transport=async()=>{calls++;return new Response(null);};
 await expect(deliverSignedNotification(command,new Uint8Array(body.length),{resolver,transport})).rejects.toThrow("outbound_body_invalid");
 const other={...command,eventId:"60000000-0000-4000-8000-000000000004",headers:{...command.headers,"webhook-id":"60000000-0000-4000-8000-000000000004"}};
 await expect(deliverSignedNotification(other,body,{resolver,transport})).rejects.toThrow("outbound_body_invalid");
 await expect(deliverSignedNotification(command,body,{resolver,transport,nowSeconds:timestamp+121})).rejects.toThrow("outbound_signature_expired");expect(calls).toBe(0);
});
