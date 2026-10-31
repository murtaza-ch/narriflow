import {expect,test} from 'bun:test';
import {DatabaseScope,getPrismaClient} from '@narriflow/db/client';
import type {PrismaClient} from '@prisma/client';
import {ExecutionDispatchPendingError} from '@narriflow/services/execution-dispatch';
import {runWorkflowCommand} from './dispatch-retry';
test('a persisted delivery retry becomes a durable timer after its database scope closes',async()=>{
 const events:string[]=[],retryAt=new Date(Date.now()+1000);
 const output=await runWorkflowCommand(()=>new DatabaseScope({createClient:()=>{events.push('open');return{client:{} as PrismaClient,dispose:async()=>{events.push('close');}};}}).run(async()=>{getPrismaClient();throw new ExecutionDispatchPendingError(retryAt);}));
 expect(events).toEqual(['open','close']);expect(output).toEqual({type:'sleep',until:retryAt.toISOString()});
});
test('an uncertain failure remains a failed step instead of inventing a retry time',async()=>{
 const failure=Error('database_unavailable');await expect(runWorkflowCommand(async()=>{throw failure;})).rejects.toBe(failure);
});
