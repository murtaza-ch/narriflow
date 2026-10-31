import {expect,test} from 'bun:test';
import type {Prisma,PrismaClient} from '@prisma/client';
import {ExecutionDispatchPendingError} from './execution-dispatch';
import {collectExecutionDispatch,withExecutionDispatches} from './execution-dispatch-runtime';
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
