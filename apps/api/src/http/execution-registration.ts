import {executionRegistrationReceipt,type ExecutionRegistrationReceipt,ExecutionRegistrationPendingError} from '@narriflow/services/execution-dispatch-runtime';
import {failureResponse} from './errors';

const MAX_RECEIPT_BODY_BYTES=64*1024;
const RECEIPT_READ_TIMEOUT_MS=1000;

/** Inspect bounded JSON only. A streaming RPC owns its receipt before encoding;
 * the HTTP boundary must never wait for an SSE response to close. */
export async function readExecutionRegistrationReceipt(response:Response):Promise<ExecutionRegistrationReceipt>{
 if(!response.headers.get('Content-Type')?.toLowerCase().includes('application/json')||!response.body)return{};
 const clone=response.clone(),reader=clone.body!.getReader(),chunks:Uint8Array[]=[];let size=0,timedOut=false;
 const cancel=()=>{void reader.cancel().catch(()=>undefined);};
 const timer=setTimeout(()=>{timedOut=true;cancel();},RECEIPT_READ_TIMEOUT_MS);
 try{
  if(Number(response.headers.get('Content-Length'))>MAX_RECEIPT_BODY_BYTES){cancel();return{};}
  while(true){const {done,value}=await reader.read();if(timedOut)return{};if(done)break;size+=value.byteLength;if(size>MAX_RECEIPT_BODY_BYTES){cancel();return{};}chunks.push(value);}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.byteLength;}
  return executionRegistrationReceipt(JSON.parse(new TextDecoder().decode(bytes)));
 }catch{return{};}finally{clearTimeout(timer);reader.releaseLock();}
}

/** Keep the accepted response's request/CORS/security policy while replacing
 * body-specific metadata. Only reference identifiers enter the error envelope. */
export function executionRegistrationFailureResponse(response:Response,error:ExecutionRegistrationPendingError):Response{
 const failure=failureResponse({code:error.code,category:'unavailable',status:503,message:error.message,requestId:response.headers.get('X-Request-ID')??crypto.randomUUID(),retryAfterSeconds:error.retryAfterSeconds,details:{retryable:true,receipt:{...error.receipt}}});
 const headers=new Headers(response.headers);for(const name of ['Content-Length','Content-Encoding','ETag','Last-Modified'])headers.delete(name);
 for(const [name,value] of failure.headers)headers.set(name,value);headers.set('Cache-Control','private, no-store');
 // Both sides of a clone must be released; never await tee cancellation while
 // its other branch can still be unread.
 void response.body?.cancel().catch(()=>undefined);
 return new Response(failure.body,{status:failure.status,headers});
}
