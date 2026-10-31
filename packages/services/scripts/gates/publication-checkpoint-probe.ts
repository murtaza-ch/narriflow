import {derivePublicationPurposeKey,sealPublicationPayload,openPublicationPayload} from "../../src/publication-checkpoint-blob";
const scope={deploymentEpoch:1,socialPostId:"00000000-0000-4000-8000-000000000001",attemptId:"00000000-0000-4000-8000-000000000002",claimId:"00000000-0000-4000-8000-000000000003",bindingHash:"a".repeat(64)};
export default{async fetch(){
 const checks:string[]=[];const check=(pass:boolean,name:string)=>{if(!pass)throw Error(name);checks.push(name);};
 const key=await derivePublicationPurposeKey(Buffer.alloc(32,7).toString("base64"),scope,"linkedin_instructions");
 // Independent Node HKDF vector from the deterministic public unit fixture.
 check(key==="fkYJ6j66OTqmwMQfeptqkzSTY4YaElbC8CkAbZp7bcM","independent_hkdf");
 const value={privateUrl:"https://www.linkedin.com/private?scoped=secret",instructions:"x".repeat(100000)},bytes=await sealPublicationPayload(value,key,scope,"linkedin_instructions");
 check(!Buffer.from(bytes).toString("utf8").includes("scoped=secret"),"ciphertext_only");
 check(JSON.stringify(await openPublicationPayload(bytes,key,scope,"linkedin_instructions"))===JSON.stringify(value),"large_checkpoint_roundtrip");
 let refused=false;try{await openPublicationPayload(bytes,key,{...scope,claimId:scope.attemptId},"linkedin_instructions");}catch{refused=true;}
 check(refused,"claim_aad_fence");
 return Response.json({runtime:"workerd",passed:checks.length,checks});
}};
