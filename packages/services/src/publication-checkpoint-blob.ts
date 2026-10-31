import { createHash } from "node:crypto";
import { publicationKeyScopeSchema, type PublicationKeyScope } from "@narriflow/validators/publication-execution";

export const PUBLICATION_CHECKPOINT_MAX_BYTES=16*1024*1024;
type Purpose="input_state"|"linkedin_instructions";
const encoder=new TextEncoder();
function info(scope:PublicationKeyScope,purpose:Purpose){
 const v=publicationKeyScopeSchema.parse(scope);
 return encoder.encode(JSON.stringify(["narriflow-publication-v1",purpose,v.deploymentEpoch,v.socialPostId,v.attemptId,v.claimId,v.bindingHash]));
}
function keyBytes(key:string){
 if(!/^[A-Za-z0-9_-]{43}$/.test(key))throw Error("publication_key_invalid");
 const bytes=Buffer.from(key,"base64url");
 if(bytes.length!==32||bytes.toString("base64url")!==key)throw Error("publication_key_invalid");
 return new Uint8Array(bytes);
}
/** Only the Worker calls this with its existing checkpoint master. Native code
 * receives the derived purpose key through the fresh work package. */
export async function derivePublicationPurposeKey(secret:string,scope:PublicationKeyScope,purpose:Purpose){
 if(!secret.trim())throw Error("publication_key_invalid");
 const decoded=Buffer.from(secret,"base64"),master=decoded.length===32?decoded:createHash("sha256").update(secret).digest();
 const base=await crypto.subtle.importKey("raw",new Uint8Array(master),"HKDF",false,["deriveBits"]);
 const bytes=await crypto.subtle.deriveBits({name:"HKDF",hash:"SHA-256",salt:encoder.encode("narriflow-publication-blob-v1"),info:info(scope,purpose)},base,256);
 return Buffer.from(bytes).toString("base64url");
}
/** A compact binary envelope: version,96-bit nonce,AES-GCM ciphertext/tag.
 * Neither an OAuth token nor the checkpoint master is ever an envelope field. */
export async function sealPublicationPayload(value:unknown,key:string,scope:PublicationKeyScope,purpose:Purpose){
 const plaintext=encoder.encode(JSON.stringify(value));
 if(plaintext.length>PUBLICATION_CHECKPOINT_MAX_BYTES-29)throw Error("publication_checkpoint_too_large");
 const iv=crypto.getRandomValues(new Uint8Array(12)),material=await crypto.subtle.importKey("raw",keyBytes(key),"AES-GCM",false,["encrypt"]);
 const ciphertext=new Uint8Array(await crypto.subtle.encrypt({name:"AES-GCM",iv,additionalData:info(scope,purpose)},material,plaintext));
 const output=new Uint8Array(13+ciphertext.length);output[0]=1;output.set(iv,1);output.set(ciphertext,13);return output;
}
export async function openPublicationPayload(bytes:Uint8Array,key:string,scope:PublicationKeyScope,purpose:Purpose):Promise<unknown>{
 if(bytes.length<29||bytes.length>PUBLICATION_CHECKPOINT_MAX_BYTES||bytes[0]!==1)throw Error("publication_checkpoint_invalid");
 try{
  const material=await crypto.subtle.importKey("raw",keyBytes(key),"AES-GCM",false,["decrypt"]);
  const plaintext=await crypto.subtle.decrypt({name:"AES-GCM",iv:new Uint8Array(bytes.subarray(1,13)),additionalData:info(scope,purpose)},material,new Uint8Array(bytes.subarray(13)));
  return JSON.parse(new TextDecoder("utf-8",{fatal:true}).decode(plaintext));
 }catch{throw Error("publication_checkpoint_invalid");}
}
