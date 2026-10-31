import {createExecutionStorage,ExecutionStorageError} from '../src/execution-storage';
import {S3Client,DeleteObjectCommand,PutObjectCommand} from '@aws-sdk/client-s3';
import {FetchHttpHandler} from '@smithy/fetch-http-handler';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {isAbsolute,join} from 'node:path';
const directory=process.env.R2_NATIVE_GATE_DIR;
if(!directory||!isAbsolute(directory))throw Error('gate_directory_required');
await mkdir(directory,{recursive:true,mode:0o700});
try{const old=JSON.parse(await readFile(join(directory,'private-state.json'),'utf8'));if(old.records?.length)throw Error('gate_recovery_required');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
const accountId=process.env.R2_ACCOUNT_ID!,accessKeyId=process.env.R2_ACCESS_KEY_ID!,secretAccessKey=process.env.R2_SECRET_ACCESS_KEY!;
if(accountId!=='5359f28d385b8632c3abee12d1f5b011'||!accessKeyId||!secretAccessKey)throw Error('requested_account_unavailable');
const bucket='narriflow-dev',runId=crypto.randomUUID(),token=crypto.randomUUID()+crypto.randomUUID();
const storage=createExecutionStorage({accountId,bucket,accessKeyId,secretAccessKey});
const client=new S3Client({region:'auto',endpoint:`https://${accountId}.r2.cloudflarestorage.com`,credentials:{accessKeyId,secretAccessKey},requestHandler:new FetchHttpHandler({requestTimeout:10000}),maxAttempts:1,requestChecksumCalculation:'WHEN_REQUIRED',responseChecksumValidation:'WHEN_REQUIRED'});
type Assignment=Awaited<ReturnType<typeof storage.create>>;
type Stored=NonNullable<Awaited<ReturnType<typeof storage.head>>>;
interface GateRecord{assignment:Assignment;parts:Map<number,[number,string,string]>;completed:boolean;completing?:boolean;source?:{storageKey:string;etag:string;byteLength:number};result?:Stored;sha256?:string;mutateOnPart:boolean;mutated:boolean;deadlineAt:number}
const records=new Map<string,GateRecord>();
function text(input:Record<string,unknown>,name:string){const value=input[name];if(typeof value!=='string'||value.length>4096)throw Error('gate_input_invalid');return value;}
function integer(input:Record<string,unknown>,name:string){const value=input[name];if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('gate_input_invalid');return value;}

const journalPath=join(directory,'private-state.json');
async function persist(){await writeFile(journalPath,JSON.stringify({accountId,bucket,runId,records:[...records.values()].map(value=>({assignment:value.assignment,completed:value.completed,completing:value.completing??false}))}),{mode:0o600});}
const readyPath=join(directory,'ready.json');
const server=Bun.serve({hostname:'127.0.0.1',port:0,idleTimeout:120,async fetch(request){
 if(request.headers.get('authorization')!==`Bearer ${token}`)return Response.json({code:'gate_unauthorized'},{status:401});
 try{
  if(Number(request.headers.get('content-length'))>65536)return Response.json({code:'gate_body_large'},{status:413});
  const parsed:unknown=await request.json();if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw Error('gate_input_invalid');const input=parsed as Record<string,unknown>,action=new URL(request.url).pathname;
  if(action==='/create'){
   const artifactId=crypto.randomUUID(),source=input.sourceArtifactId?records.get(text(input,'sourceArtifactId')):undefined;
   if(input.sourceArtifactId&&(!source?.completed||!source.result||source.assignment.byteLength!==integer(input,'byteLength')))throw Error('gate_source_invalid');
   const value={artifactId,storageKey:`execution/platform-gates/${runId}/${artifactId}/native.bin`,bindingHash:'a'.repeat(64),contentType:'application/octet-stream',byteLength:integer(input,'byteLength')};
   const assignment=await storage.create(value);
   records.set(artifactId,{assignment,parts:new Map(),completed:false,source:source?{storageKey:source.assignment.storageKey,etag:source.result!.etag,byteLength:integer(input,'byteLength')}:undefined,mutateOnPart:!!input.mutateOnPart,mutated:false,deadlineAt:Date.now()+4*3600_000});await persist();
   return Response.json({artifactId,uploadId:assignment.uploadId,byteLength:assignment.byteLength,partSizeBytes:assignment.partSizeBytes});
  }
  if(action==='/cleanup'){
   let deleted=0,aborted=0,uncertain=0;
   for(const [artifactId,record] of records){
    try{
     if(record.completed){await client.send(new DeleteObjectCommand({Bucket:bucket,Key:record.assignment.storageKey}));deleted++;records.delete(artifactId);}
     else if(!record.completing){await storage.abort(record.assignment);aborted++;records.delete(artifactId);}
     else uncertain++;
    }catch{uncertain++;}
   }
   await persist();return Response.json({deleted,aborted,uncertain});
  }
  const record=records.get(text(input,'artifactId'));if(!record)throw Error('gate_assignment_missing');
  const assignment=record.assignment;
  const window={leaseExpiresAt:new Date(Date.now()+120000),operationDeadlineAt:new Date(record.deadlineAt)};
  if(action==='/part'){
   if(record.completed||record.completing)throw Error('gate_already_completed');const partNumber=integer(input,'partNumber'),byteLength=integer(input,'byteLength'),checksumMd5=text(input,'checksumMd5'),checksumSha256=text(input,'checksumSha256');
   const existing=record.parts.get(partNumber),plan:[number,string,string]=[byteLength,checksumMd5,checksumSha256];
   if(existing&&JSON.stringify(existing)!==JSON.stringify(plan))throw Error('gate_checksum_conflict');
   if(record.mutateOnPart&&!record.mutated){
    if(!record.source)throw Error('gate_source_missing');
    await client.send(new PutObjectCommand({Bucket:bucket,Key:record.source.storageKey,Body:new Uint8Array([9]),ContentLength:1,ContentType:'application/octet-stream'}));
    record.mutated=true;
   }
   const grant=await storage.signPart(assignment,{partNumber,byteLength,checksumMd5,checksumSha256,...window});record.parts.set(partNumber,plan);return Response.json(grant);
  }
  if(action==='/range'){
   if(!record.source||text(input,'sourceEtag')!==record.source.etag)throw Error('gate_source_binding_changed');
   return Response.json(await storage.signSourceRange(assignment,record.source,{...window,start:integer(input,'start'),end:integer(input,'end')}));
  }
  if(action==='/complete'){
   if(record.completed){if(record.sha256!==text(input,'sha256'))throw Error('gate_completion_conflict');return Response.json({...record.result,sha256:record.sha256});}
   if(integer(input,'byteLength')!==assignment.byteLength||!/^[a-f0-9]{64}$/.test(text(input,'sha256')))throw Error('gate_completion_invalid');
   const inventory=await storage.listParts(assignment);
   const parts=inventory.map(part=>{const plan=record.parts.get(part.partNumber);if(!plan||plan[0]!==part.byteLength||plan[1]!==part.checksumMd5)throw Error('gate_part_changed');return {...part,checksumSha256:plan[2]};});
   record.completing=true;record.sha256=text(input,'sha256');await persist();
   record.result=await storage.complete(assignment,parts);record.completed=true;await persist();
   return Response.json({...record.result,sha256:record.sha256});
  }
  if(action==='/head')return Response.json(await storage.head(assignment));
  if(action==='/abort'){if(!record.completed&&!record.completing)await storage.abort(assignment);return Response.json({aborted:!record.completed&&!record.completing,mutated:record.mutated});}
  throw Error('gate_action_invalid');
 }catch(error){const code=error instanceof ExecutionStorageError?error.code:error instanceof Error&&/^[a-z0-9_]+$/.test(error.message)?error.message:'gate_provider_failed';return Response.json({code},{status:500});}
}});
await writeFile(readyPath,JSON.stringify({url:`http://127.0.0.1:${server.port}`,token}),{mode:0o600});
console.log(JSON.stringify({message:'native_r2_gate_grant_service_ready',providerAccountVerified:true}));
