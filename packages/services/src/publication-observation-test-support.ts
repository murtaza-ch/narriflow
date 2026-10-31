import {readExecutionDispatch} from "./execution-dispatch";
import type {Prisma,PrismaClient} from '@prisma/client';
import {appendPerformanceCapture,appendPerformanceGuidance,createPublicationObservations,trackPublishedVideo} from './publication-observations';
/** A test-only observation of one exact SELECT. The SQL still executes on real
 * PostgreSQL; transactions, row locks, writes and all constraints stay intact.
 * No production clock setting or domain input is changed. */
export function withObservationTestClock(database:PrismaClient,now:Date):PrismaClient{
 const wrap=(tx:Prisma.TransactionClient):Prisma.TransactionClient=>new Proxy(tx,{get(target,key){
  if(key==='$queryRaw')return async(...args:unknown[])=>{
   const first=args[0] as {sql?:string;strings?:readonly string[]}|readonly string[];
   const sql=(Array.isArray(first)?first.join('?'):(first as {sql?:string;strings?:readonly string[]}).sql??(first as {strings?:readonly string[]}).strings?.join('?')??'').replace(/\s+/g,' ').trim();
   const result=await Reflect.apply(target.$queryRaw,target,args);
   if(sql!=="SELECT clock_timestamp() AT TIME ZONE 'UTC' AS now")return result;
   if(!Array.isArray(result)||result.length!==1||!(result[0].now instanceof Date))throw Error('Expected actual SQL clock observation');
   return [{...result[0],now:new Date(now)}];
  };
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
 return new Proxy(database,{get(target,key){
  if(key==='$transaction')return (operation:unknown,options?:unknown)=>typeof operation==='function'?target.$transaction(tx=>operation(wrap(tx)),options as never):Reflect.apply(target.$transaction,target,[operation,options]);
  const value=Reflect.get(target,key);return typeof value==='function'?value.bind(target):value;
 }});
}
export interface KnownPerformanceSubjects {published:Array<{socialPostId:string;platformPostId:string}>;tracked:Set<string>}
export function createPerformanceTestRuntime(input:{database:PrismaClient;subjects:KnownPerformanceSubjects;fetch:typeof fetch;accounts:{getPublishAccount(id:string):Promise<{accessToken:string}>};now?:()=>Date}){
 return{
  async scheduleKnownVideos(){
   const db=withObservationTestClock(input.database,input.now?.()??new Date());
   for(const subject of input.subjects.published){const id=await db.$transaction(tx=>trackPublishedVideo(tx,subject));if(id)input.subjects.tracked.add(id);}
  },
  async driveKnownCaptures(){
   const at=input.now?.()??new Date(),db=withObservationTestClock(input.database,at),driver=createPublicationObservations({database:db,fetch:input.fetch,accounts:input.accounts,register:async()=>{}});
   const rows=await db.performanceCapture.findMany({where:{trackedVideoId:{in:[...input.subjects.tracked]},state:'scheduled',dueAt:{lte:at}},orderBy:[{slot:'desc'},{id:'asc'}],select:{id:true}});
   for(const row of rows)for(let action=0;action<3;action++){
    const reference=await db.$transaction(tx=>appendPerformanceCapture(tx,row.id));if(!reference)break;
    const result=await driver.dispatch((await readExecutionDispatch(db,reference))!.reference);if(result.kind==='sleep')break;
    const current=await db.performanceCapture.findUnique({where:{id:row.id}});
    if(!current||current.state!=='scheduled'||current.dueAt>at||current.leaseExpiresAt&&current.leaseExpiresAt>at)break;
   }
  },
 };
}
export async function computeKnownGuidance(database:PrismaClient,workspaceId:string,at=new Date()){
 const db=withObservationTestClock(database,at),reference=await db.$transaction(tx=>appendPerformanceGuidance(tx,workspaceId,new Date(Math.floor(at.getTime()/86400_000)*86400_000)));
 return createPublicationObservations({database:db,fetch:async()=>{throw Error('Guidance must perform no provider HTTP');},accounts:{getPublishAccount:async()=>{throw Error('Guidance must read no account token');}},register:async()=>{}}).dispatch((await readExecutionDispatch(db,reference))!.reference);
}
