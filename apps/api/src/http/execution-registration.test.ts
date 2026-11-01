import {expect,test} from 'bun:test';
import {readExecutionRegistrationReceipt,executionRegistrationFailureResponse} from './execution-registration';
import {ExecutionRegistrationPendingError} from '@narriflow/services/execution-dispatch-runtime';
const projectId='11111111-1111-4111-8111-111111111111';
test('receipt JSON parsing is bounded by bytes even with a lying Content-Length',async()=>{
 let cancelled=false;const response=new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode(JSON.stringify({projectId,transcript:'PRIVATE'.repeat(20000)})));},cancel(){cancelled=true;}}),{headers:{'Content-Type':'application/json','Content-Length':'1'}});
 expect(await readExecutionRegistrationReceipt(response)).toEqual({});executionRegistrationFailureResponse(response,new ExecutionRegistrationPendingError({},Error('PRIVATE')));await Promise.resolve();expect(cancelled).toBe(true);
});
test('an SSE receipt is never parsed or awaited',async()=>{
 let read=false;const response=new Response(new ReadableStream({pull(){read=true;}},{highWaterMark:0}),{headers:{'Content-Type':'text/event-stream'}});
 expect(await readExecutionRegistrationReceipt(response)).toEqual({});expect(read).toBe(false);void response.body?.cancel();
});
test('small JSON retains only references and error rewriting preserves headers without stale body metadata',async()=>{
 const response=Response.json({projectId,grant:'PRIVATE'},{headers:{'X-Request-ID':'retained','Access-Control-Allow-Origin':'https://web.test','X-Content-Type-Options':'nosniff','Content-Length':'9999',ETag:'old-body'}}),receipt=await readExecutionRegistrationReceipt(response),failed=executionRegistrationFailureResponse(response,new ExecutionRegistrationPendingError(receipt,Error('PRIVATE')));
 expect(failed.status).toBe(503);expect(failed.headers.get('X-Request-ID')).toBe('retained');expect(failed.headers.get('Access-Control-Allow-Origin')).toBe('https://web.test');expect(failed.headers.has('Content-Length')).toBe(false);expect(failed.headers.has('ETag')).toBe(false);const body=await failed.json();expect(body.details.receipt).toEqual({projectId});expect(JSON.stringify(body)).not.toContain('PRIVATE');
});
test('a stalled JSON body cannot hold a postcommit failure open indefinitely',async()=>{
 const response=new Response(new ReadableStream<Uint8Array>({pull(){}},{highWaterMark:0}),{headers:{'Content-Type':'application/json'}});expect(await readExecutionRegistrationReceipt(response)).toEqual({});executionRegistrationFailureResponse(response,new ExecutionRegistrationPendingError({},Error('fixture')));
});
