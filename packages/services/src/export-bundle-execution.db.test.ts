import { afterAll,beforeAll,describe,expect,test } from "bun:test";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";

const url=process.env.SERVERLESS_TEST_DATABASE_URL;
const suite=process.env.ALLOW_SERVERLESS_DB_TESTS==="1"&&url?describe:describe.skip;
suite("Targeted export bundle execution",()=>{
  let db:PrismaClient;
  beforeAll(()=>{
    const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA!;
    assertExecutionDatabaseTestTarget(url,schema);
    db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:4},{schema}),transactionOptions:{timeout:30000,maxWait:10000}});
  });
  afterAll(async()=>{await db?.$disconnect();});
  async function fixture(){
    const user=await db.user.create({data:{clerkId:`bundle-execution:${crypto.randomUUID()}`}});
    const workspace=await db.workspace.create({data:{ownerUserId:user.id,name:"Bundle gate",pricingTier:"business"}});
    const project=await db.project.create({data:{workspaceId:workspace.id,title:"Bundle gate",sourceMediaUrl:"r2://frozen/source",ingestStatus:"ready"}});
    const epoch=(await db.executionEpoch.findUniqueOrThrow({where:{id:1}})).epoch;
    const run=await db.workflowRun.create({data:{projectId:project.id,stage:"export_bundle",status:"queued",deploymentEpoch:epoch,idempotencyKey:crypto.randomUUID()}});
    const operation=await db.campaignOperation.create({data:{workspaceId:workspace.id,projectId:project.id,actorUserId:user.id,action:"export_bundle",idempotencyKey:crypto.randomUUID(),requestFingerprint:"a".repeat(64),validatedOptions:{},pricingTier:"business",requestedCount:1,workflowRunId:run.id}});
    const bundle=await db.exportBundle.create({data:{operationId:operation.id,workflowRunId:run.id,deploymentEpoch:epoch,manifest:{schemaVersion:1,operationId:operation.id,projectId:project.id,createdAt:operation.createdAt.toISOString(),included:[],excluded:[]}}});
    return {user,workspace,project,run,operation,bundle};
  }
  test("the accepted manifest, deadline and complete input tuple cannot be rewritten",async()=>{
    const f=await fixture();
    try{
      await expect(Promise.resolve(db.exportBundle.update({where:{id:f.bundle.id},data:{inputStorageKey:"projects/partial.json"}}))).rejects.toThrow();
      const input={inputBindingHash:"a".repeat(64),inputStorageKey:`projects/${f.project.id}/export-bundles/${f.bundle.id}/${crypto.randomUUID()}.json`,inputEtag:'"capsule"',inputByteLength:200n,inputChecksumSha256:"b".repeat(64)};
      await db.exportBundle.update({where:{id:f.bundle.id},data:input});
      await expect(Promise.resolve(db.exportBundle.update({where:{id:f.bundle.id},data:{inputEtag:'"replacement"'}}))).rejects.toThrow("immutable");
      await expect(Promise.resolve(db.exportBundle.update({where:{id:f.bundle.id},data:{manifest:{changed:true}}}))).rejects.toThrow("immutable");
      await expect(Promise.resolve(db.exportBundle.update({where:{id:f.bundle.id},data:{operationDeadlineAt:new Date(f.bundle.operationDeadlineAt.getTime()+1000)}}))).rejects.toThrow("immutable");
      expect(await db.exportBundle.findUniqueOrThrow({where:{id:f.bundle.id}})).toMatchObject(input);
    }finally{await db.workspace.delete({where:{id:f.workspace.id}});await db.user.delete({where:{id:f.user.id}});}
  });
});
