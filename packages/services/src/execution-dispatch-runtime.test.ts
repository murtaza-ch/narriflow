import {expect,test} from 'bun:test';
import type {Prisma,PrismaClient} from '@prisma/client';
import {ExecutionDispatchPendingError} from './execution-dispatch';
import {collectExecutionDispatch,withExecutionDispatches,executionRegistrationReceipt,ExecutionRegistrationPendingError} from './execution-dispatch-runtime';
const id='00000000-0000-0000-0000-000000000001';
const tx={} as Prisma.TransactionClient;
const database={executionDispatch:{findMany:async()=>[{id}]}} as unknown as PrismaClient;
test('a persisted prerequisite retry leaves dependent dispatches pending instead of bypassing its failure',async()=>{
 let deliveries=0;const pending=new ExecutionDispatchPendingError(new Date(Date.now()+1000));
 await expect(withExecutionDispatches(async()=>{collectExecutionDispatch(tx,id);throw pending;},{database,deliver:async()=>{deliveries++;}})).rejects.toBe(pending);
 expect(deliveries).toBe(0);
});
test('other postcommit failures still deliver their explicitly collected obligations',async()=>{
 let deliveries=0;const failure=Error('committed_callback_needs_wake');
 await expect(withExecutionDispatches(async()=>{collectExecutionDispatch(tx,id);throw failure;},{database,deliver:async ids=>{expect(ids).toEqual([id]);deliveries++;}})).rejects.toBe(failure);
 expect(deliveries).toBe(1);
});
test('an automatic flush preserves the known persisted retry for the Workflow boundary',async()=>{
 const pending=new ExecutionDispatchPendingError(new Date(Date.now()+1000));
 await expect(withExecutionDispatches(async()=>{collectExecutionDispatch(tx,id);return 'committed';},{database,deliver:async()=>{throw pending;}})).rejects.toBe(pending);
});

test('ordinary nested service work shares its collector while an independent RPC flushes its own committed IDs',async()=>{
 const outer='00000000-0000-0000-0000-000000000002',inner='00000000-0000-0000-0000-000000000003',calls:Array<{scope:string;ids:readonly string[]}>=[];
 const store={executionDispatch:{findMany:async(input:{where:{id:{in:string[]}}})=>input.where.id.in.map(id=>({id}))}} as unknown as PrismaClient;
 await withExecutionDispatches(async()=>{
  collectExecutionDispatch(tx,outer);
  await withExecutionDispatches(async()=>collectExecutionDispatch(tx,id),{database:store,deliver:async()=>{throw Error('nested service must not flush independently');}});
  await withExecutionDispatches(async()=>collectExecutionDispatch(tx,inner),{database:store,independent:true,deliver:async ids=>{calls.push({scope:'rpc',ids});}});
 },{database:store,deliver:async ids=>{calls.push({scope:'http',ids});}});
 expect(calls).toEqual([{scope:'rpc',ids:[inner]},{scope:'http',ids:[outer,id]}]);
});

test('registration failures retain only bounded reference identifiers from HTTP and MCP receipts',()=>{
 const projectId='11111111-1111-4111-8111-111111111111',jobId='22222222-2222-4222-8222-222222222222',taskId='33333333-3333-4333-8333-333333333333';
 expect(executionRegistrationReceipt({data:{projectId,operation:{kind:'intake',id:jobId},signedUrl:'PRIVATE_GRANT',transcript:'PRIVATE_TEXT'},private:'PRIVATE_PROVIDER'})).toEqual({projectId,operation:{kind:'intake',id:jobId}});
 expect(executionRegistrationReceipt({taskId,_meta:{'narriflow/operation':{projectId,domainKind:'generation',domainId:jobId},privateGrant:'PRIVATE_GRANT'},content:[{text:'PRIVATE_TEXT'}]})).toEqual({taskId,projectId,operation:{kind:'generation',id:jobId}});
 expect(executionRegistrationReceipt({projectId:'https://PRIVATE.invalid',queuedJobId:'x'.repeat(10000),operation:{kind:'unknown',id:jobId},taskId:'latest'})).toEqual({});
 const original=new ExecutionDispatchPendingError(new Date(Date.now()+5000)),failure=new ExecutionRegistrationPendingError({projectId},original);expect(failure.cause).toBe(original);expect(failure.retryAfterSeconds).toBeGreaterThanOrEqual(1);expect(failure.retryAfterSeconds).toBeLessThanOrEqual(5);
});

test('registration receipts retain REST upload and accepted-operation references without transfer or callback data',async()=>{
 const {restApiSchemas:{uploadResultSchema,acceptedProjectSchema}}=await import('@narriflow/validators');
 const uploadId='44444444-4444-4444-8444-444444444444',projectId='55555555-5555-4555-8555-555555555555',operationId='op_AAAAAAAAAAAAAAAAAAAAAAA';
 const operation={operationId,kind:'intake' as const,statusUrl:'https://api.test/operations/PRIVATE_STATUS'};
 const upload=uploadResultSchema.parse({upload:{uploadId,state:'queued_for_ingest',projectId,expiresAt:null,transfer:null,retryAfterSeconds:null,failureCode:null,operation}});
 expect(executionRegistrationReceipt(upload)).toEqual({uploadId,projectId,operationId});
 const accepted=acceptedProjectSchema.parse({projectId,operation,reviewUrl:'https://web.test/PRIVATE_REVIEW',callback:null});
 expect(executionRegistrationReceipt(accepted)).toEqual({projectId,operationId});
});
