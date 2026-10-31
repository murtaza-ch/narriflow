/** Disposable-schema integration harness. Never imported by an app. It drives
 * one known Rule through public command/control seams with a controlled native
 * fetch and object store; it does not scan for or claim unrelated work. */
import { createHash,randomUUID } from "node:crypto";
import type { PrismaClient } from "@prisma/client";
import { rssFeedSnapshotSchema,outboundRssInputSchema,type RssFeedSnapshot } from "@narriflow/validators/outbound-probe";
import { AutopilotService } from "./autopilot.service";
import { createAutopilotExecutionRuntime } from "./autopilot-execution-runtime";
import { queueAutopilotRule,type AutopilotExecutionResult } from "./autopilot-execution";
import { OutboundProbeService } from "./outbound-probe";
import { createExecutorControl } from "./executor-control";
import { readExecutionDispatch } from "./execution-dispatch";
import type { fetchRssFeed } from "./rss";
const stores=new WeakMap<PrismaClient,Map<string,RssFeedSnapshot>>();
export interface AutopilotTestOptions {
  fetchFeed?:typeof fetchRssFeed;
  beforeSnapshotRead?:()=>Promise<void>;
}
export class AutopilotTestRuntime extends AutopilotService {
  readonly probe:OutboundProbeService;
  readonly driver:ReturnType<typeof createAutopilotExecutionRuntime>;
  private readonly snapshots:Map<string,RssFeedSnapshot>;
  constructor(private readonly database:PrismaClient,private readonly testOptions:AutopilotTestOptions={}){
    super({fetchFeed:testOptions.fetchFeed});
    let snapshots=stores.get(database);if(!snapshots){snapshots=new Map();stores.set(database,snapshots);}this.snapshots=snapshots;
    this.probe=new OutboundProbeService(database,{register:async()=>{},readResult:async artifact=>{
      await this.testOptions.beforeSnapshotRead?.();
      const value=this.snapshots.get(artifact.storageKey);if(!value)throw Error("Test source object is missing");return value;
    }});
    this.driver=createAutopilotExecutionRuntime({database,probe:this.probe,register:async()=>{}});
  }
  async drive(ruleId:string):Promise<AutopilotExecutionResult&{imported:number}>{
    const before=await this.database.autopilotEpisode.count({where:{ruleId}}),initial=await this.database.$transaction(tx=>queueAutopilotRule(tx,ruleId));
    const finish=async(result:AutopilotExecutionResult)=>({...result,imported:Math.max(0,(await this.database.autopilotEpisode.count({where:{ruleId}}))-before)});
    if(!initial)return finish({kind:"superseded"});
    let reference=initial,cycleId:string|null=null;
    for(let command=0;command<32;command++){
      const observed=await this.database.autopilotRule.findUnique({where:{id:ruleId}});
      if(!observed)return finish({kind:"superseded"});
      if(observed.executionCycleId){
        if(cycleId&&cycleId!==observed.executionCycleId)return finish({kind:"superseded"});
        cycleId=observed.executionCycleId;
        if(observed.executionProbeId){
          const probe=await this.database.outboundProbe.findUniqueOrThrow({where:{id:observed.executionProbeId}});
          if(probe.status==="queued"&&!probe.executorOwner)await this.completeNativeProbe(probe.id);
        }
      }
      const result=await this.driver.run(reference);
      if(result.kind==="superseded"||result.kind==="sleep")return finish(result);
      const row=await this.database.autopilotRule.findUnique({where:{id:ruleId}});
      if(!row)return finish({kind:"superseded"});
      if(!row.executionCycleId)return finish(result);
      if(!cycleId)cycleId=row.executionCycleId;
      if(result.kind==="wait")return finish(result);
      const next=await this.database.$transaction(tx=>queueAutopilotRule(tx,ruleId));
      if(!next)return finish({kind:"complete"});reference=next;
    }
    throw Error("Test command bound exceeded");
  }
  async completeNativeProbe(id:string){
    const db=this.database,row=await db.outboundProbe.findUniqueOrThrow({where:{id}});
    const parent=await db.executionDispatch.findFirstOrThrow({where:{subjectKind:"outbound_probe",subjectId:id,deploymentEpoch:row.deploymentEpoch,generation:row.generation,kind:"operation_driver",deadlineKind:null},orderBy:{createdAt:"asc"}});
    const plan=await this.probe.prepareExecution((await readExecutionDispatch(db,parent.id))!.reference);
    if(plan.kind!=="waiting")throw Error("Native test probe must be admitted");
    const {reference,attemptToken}=plan.deadline,owner=randomUUID(),fence={reference,attemptToken,owner};
    let snapshot:RssFeedSnapshot|undefined;
    const bytes=()=>Buffer.from(JSON.stringify(snapshot)),sha=()=>createHash("sha256").update(bytes()).digest("hex");
    const control=createExecutorControl({database:db,subjectKind:"outbound_probe",domain:this.probe,deliverWakes:async()=>{},artifacts:{prepare:async(_assigned,artifact)=>artifact,head:async()=>({etag:'"test-sealed"',contentType:"application/json",byteLength:BigInt(bytes().length),sha256:sha()})}});
    const verified=()=>({requestHash:randomUUID().replaceAll("-","").repeat(2),metadata:{version:1 as const,keyId:"test-native",audience:"executor-control" as const,method:"POST" as const,canonicalTarget:"/api/execution/command",bodySha256:"0".repeat(64),timestamp:Math.floor(Date.now()/1000),deliveryId:randomUUID(),signature:"0".repeat(64)}});
    await control.execute({command:{action:"acquire",reference,attemptToken,owner,leaseSeconds:120},verifiedRequest:verified()});
    await control.execute({command:{action:"process-start",fence},verifiedRequest:verified()});
    const input=outboundRssInputSchema.parse(row.input);
    try{
      if(!this.testOptions.fetchFeed)throw Error("Unexpected native fetch in test");
      snapshot=rssFeedSnapshotSchema.parse(await this.testOptions.fetchFeed(input.url,{scope:{workspaceId:row.workspaceId,actorUserId:row.createdByUserId},etag:input.etag,lastModified:input.lastModified}));
    }catch(error){
      const code=error&&typeof error==="object"&&"code" in error&&typeof error.code==="string"&&/^[a-z][a-z0-9_]{0,99}$/.test(error.code)?error.code:"remote_download_failed";
      await control.execute({command:{action:"fail",fence,failureCode:code,retryable:false},verifiedRequest:verified()});return;
    }
    const storageKey=`execution/${reference.deploymentEpoch}/${attemptToken}/${owner}/feed.json`;
    this.snapshots.set(storageKey,snapshot);
    const artifact=await db.executionArtifact.create({data:{attemptToken,owner,role:"outbound_receipt",bindingHash:reference.inputHash,storageKey,contentType:"application/json",maxBytes:4194304n,grantExpiresAt:new Date(Date.now()+60_000)}});
    await control.execute({command:{action:"commit-artifact",fence,artifact:{artifactId:artifact.id,role:"outbound_receipt",bindingHash:reference.inputHash,contentType:"application/json",byteLength:bytes().length,sha256:sha(),etag:'"test-sealed"'}},verifiedRequest:verified()});
  }
}
