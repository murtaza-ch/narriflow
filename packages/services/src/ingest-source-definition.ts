import { detectLinkProvider,LINK_PROVIDERS,zoomIngestPayloadSchema } from "@narriflow/validators";
import type { IngestJob } from "@prisma/client";
import { ingestAcquisitionSchema,ingestDirectReadSchema,ingestUploadReadSchema,type IngestUploadRead,type IngestDirectRead,type SourceVideoBinding } from "@narriflow/validators/execution";

type Job=Pick<IngestJob,"jobType"|"payload"|"sourceCredential"|"projectId">;
export interface IngestSourceReadPorts {
 openDriveCredential?(sealed:string):string|Promise<string>;
 zoomRecordingDownload?(input:{projectId:string;connectionId:string;meetingUuid:string;recordingId:string}):Promise<{downloadUrl:string;accessToken:string}>;
}
export class IngestSourceDefinitionError extends Error {
 constructor(readonly code:string,readonly retryable=false){super(code);}
}
function payload(job:Job){
 if(!job.payload||typeof job.payload!=="object"||Array.isArray(job.payload))throw new IngestSourceDefinitionError("worker_invalid_payload");
 ingestAcquisitionSchema.parse(job.payload.acquisition);return job.payload;
}
async function identityHash(value:unknown){return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(JSON.stringify(value)))),byte=>byte.toString(16).padStart(2,"0")).join("");}
function episode(value:ReturnType<typeof payload>){const item=value.episode;if(!item||typeof item!=="object"||Array.isArray(item)||typeof item.id!=="string"||typeof item.enclosureUrl!=="string")throw new IngestSourceDefinitionError("rss_missing_enclosure");return item;}
function link(value:ReturnType<typeof payload>){
 if(typeof value.url!=="string"||value.url.length>8192)throw new IngestSourceDefinitionError("link_unsupported_source");
 const provider=detectLinkProvider(value.url),definition=LINK_PROVIDERS.find(item=>item.id===provider);
 if(!provider||provider==="youtube"||value.provider!==provider||!definition)throw new IngestSourceDefinitionError("link_unsupported_source");return definition;
}
function uploadId(value:unknown){if(typeof value!=="string"||!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value))throw new IngestSourceDefinitionError("worker_invalid_payload");return value;}
function upload(value:ReturnType<typeof payload>){return ingestUploadReadSchema.parse({storageKey:value.storageKey,etag:value.verifiedEtag,byteLength:value.verifiedSizeBytes,contentType:value.verifiedContentType});}
function recording(value:ReturnType<typeof payload>){return zoomIngestPayloadSchema.parse({connectionId:value.connectionId,meetingUuid:value.meetingUuid,recordingId:value.recordingId});}
export async function ingestSourceMediaIdentity(job:Job):Promise<SourceVideoBinding["mediaIdentity"]>{
 const value=payload(job);
 if(job.jobType==="upload_finalize"){upload(value);return {provider:"upload",mediaId:uploadId(value.uploadSessionId)};}
 if(job.jobType==="drive_import"&&typeof value.fileId==="string"&&/^[A-Za-z0-9_-]{10,200}$/.test(value.fileId))return {provider:"drive",mediaId:value.fileId};
 if(job.jobType==="link_import"){link(value);return {provider:"direct",mediaId:await identityHash(["link",value.provider,value.url])};}
 if(job.jobType==="zoom_import")return {provider:"zoom",mediaId:await identityHash(["zoom",recording(value)])};
 if(job.jobType==="rss_import"){const item=episode(value);return {provider:"rss",mediaId:await identityHash(["rss",value.rssUrl,item.id,item.enclosureUrl])};}
 throw new IngestSourceDefinitionError("worker_invalid_payload");
}
export type IngestSourceDefinition={kind:"direct_source"|"extractor_source";mediaIdentity:SourceVideoBinding["mediaIdentity"];source:IngestDirectRead}|
 {kind:"upload_source";mediaIdentity:SourceVideoBinding["mediaIdentity"];source:IngestUploadRead};
async function resolveDefinition(job:Job,ports:IngestSourceReadPorts):Promise<IngestSourceDefinition>{
 const mediaIdentity=await ingestSourceMediaIdentity(job);
 if(job.jobType==="upload_finalize")return {kind:"upload_source",mediaIdentity,source:upload(payload(job))};
 if(job.jobType==="link_import"){
  const value=payload(job),url=new URL(String(value.url));url.hash="";
  if(value.provider==="dropbox")url.searchParams.set("dl","1");
  const strategy=link(value).strategy;
  return {kind:strategy==="direct"?"direct_source":"extractor_source",mediaIdentity,source:ingestDirectReadSchema.parse({provider:"direct",url:url.toString(),authorization:null})};
 }
 if(job.jobType==="rss_import")return {kind:"direct_source",mediaIdentity,source:ingestDirectReadSchema.parse({provider:"rss",url:episode(payload(job)).enclosureUrl,authorization:null})};
 if(job.jobType==="zoom_import"){
  if(!ports.zoomRecordingDownload)throw new IngestSourceDefinitionError("zoom_recording_unavailable");
  let read:{downloadUrl:string;accessToken:string};
  try{read=await ports.zoomRecordingDownload({projectId:job.projectId,...recording(payload(job))});}
  catch(error){const code=error&&typeof error==="object"&&"code" in error?error.code:null;throw new IngestSourceDefinitionError(code==="zoom_recording_unavailable"||code==="zoom_connection_unavailable"?code:"source_download_failed",code!=="zoom_recording_unavailable"&&code!=="zoom_connection_unavailable");}
  return {kind:"direct_source",mediaIdentity,source:ingestDirectReadSchema.parse({provider:"zoom",url:read.downloadUrl,authorization:`Bearer ${read.accessToken}`})};
 }
 if(job.jobType==="drive_import"){
  if(!job.sourceCredential||!ports.openDriveCredential)throw new IngestSourceDefinitionError("drive_token_expired");
  let token:string;try{token=await ports.openDriveCredential(job.sourceCredential);}catch{throw new IngestSourceDefinitionError("worker_invalid_payload");}
  return {kind:"direct_source",mediaIdentity,source:ingestDirectReadSchema.parse({provider:"drive",url:`https://www.googleapis.com/drive/v3/files/${mediaIdentity.mediaId}?alt=media&supportsAllDrives=true`,authorization:`Bearer ${token}`})};
 }
 throw new IngestSourceDefinitionError("worker_invalid_payload");
}

/** Provider exceptions never export a URL, opened credential or response body. */
export async function resolveIngestSourceDefinition(job:Job,ports:IngestSourceReadPorts):Promise<IngestSourceDefinition>{
 try{return await resolveDefinition(job,ports);}catch(error){if(error instanceof IngestSourceDefinitionError)throw error;throw new IngestSourceDefinitionError("worker_invalid_payload");}
}
