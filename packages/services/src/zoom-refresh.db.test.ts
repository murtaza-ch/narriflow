import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { createDatabaseTestContext } from "@narriflow/db/testing";
import { withServiceEnvironment } from "./runtime-environment";
import { assertExecutionDatabaseTestTarget } from "./execution-db-test-support";
import { ZoomService } from "./zoom.service";
import { createZoomTokenCipher, ZOOM_SCOPES } from "./zoom";
import type { ZoomApi } from "./zoom-api";
const url=process.env.SERVERLESS_TEST_DATABASE_URL;
const suite=process.env.ALLOW_SERVERLESS_DB_TESTS==="1"&&url?describe:describe.skip;
const config={clientId:"synthetic",clientSecret:"synthetic",webhookSecret:"synthetic",encryptionKey:"synthetic-zoom-cipher"};
const tokens={access_token:"refreshed-access",refresh_token:"refreshed-rotation",expires_in:3600,scope:ZOOM_SCOPES.join(" ")};
suite("Bounded Zoom rotating credential ownership",()=>{
  let db:PrismaClient,observer:PrismaClient;
  const context=createDatabaseTestContext();
  const scoped=<T>(run:()=>Promise<T>)=>()=>withServiceEnvironment(process.env,context.bind(run));
  beforeAll(()=>{const schema=process.env.SERVERLESS_TEST_DATABASE_SCHEMA??"public";assertExecutionDatabaseTestTarget(url,schema);db=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:6},{schema})});observer=new PrismaClient({adapter:new PrismaPg({connectionString:url,max:2},{schema})});context.client=db;});
  afterAll(async()=>{await db?.$disconnect();await observer?.$disconnect();});
  async function fixture(){
    const user=await db.user.create({data:{clerkId:`zoom-refresh:${crypto.randomUUID()}`}});
    const workspace=await db.workspace.create({data:{name:"Zoom refresh",ownerUserId:user.id,pricingTier:"business",members:{create:{userId:user.id,role:"owner"}}}});
    const project=await db.project.create({data:{workspaceId:workspace.id,title:"Synthetic recording",sourceType:"zoom",sourceMediaUrl:"https://zoom.us/synthetic"}});
    const cipher=createZoomTokenCipher(config.encryptionKey);
    const connection=await db.zoomConnection.create({data:{workspaceId:workspace.id,userId:user.id,zoomUserId:"synthetic-host",zoomAccountId:crypto.randomUUID(),displayName:"Synthetic",accessTokenEncrypted:cipher.seal("original-access"),refreshTokenEncrypted:cipher.seal("original-rotation"),expiresAt:new Date(Date.now()-60_000),authorizedAt:new Date(Date.now()-120_000),scopes:[...ZOOM_SCOPES]}});
    const input={connectionId:connection.id,projectId:project.id,meetingUuid:"meeting-one",recordingId:"recording-one"};
    return {user,workspace,project,connection,cipher,input};
  }
  function api(refresh:ZoomApi["refresh"]):ZoomApi{return {refresh,exchange:async()=>tokens,me:async()=>({id:"synthetic-host",account_id:"synthetic-account",displayName:"Synthetic"}),recording:async()=>"https://us02web.zoom.us/rec/download/synthetic",revoke:async()=>{}};}
  test("a concurrent reader waits for the bounded refresh owner and never submits another rotation",scoped(async()=>{
    const f=await fixture();let calls=0,release!:()=>void,entered!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const service=new ZoomService({config:()=>config,api:api(async()=>{calls++;entered();await wait;return tokens;})});
    const first=service.recordingDownload(f.input);
    await started;
    try{await expect(service.recordingDownload(f.input)).rejects.toMatchObject({code:"zoom_api_unavailable"});expect(calls).toBe(1);}finally{release();}
    expect(await first).toMatchObject({accessToken:"refreshed-access"});
    expect(await service.recordingDownload(f.input)).toMatchObject({accessToken:"refreshed-access"});
    expect(calls).toBe(1);
  }));
  test("unknown provider acceptance becomes unusable and cannot be blindly refreshed again",scoped(async()=>{
    const f=await fixture();let calls=0;
    const service=new ZoomService({config:()=>config,api:api(async()=>{calls++;throw Error("synthetic response lost after provider acceptance");})});
    await expect(service.recordingDownload(f.input)).rejects.toMatchObject({code:"zoom_connection_unavailable"});
    const unknown=await db.zoomConnection.findUniqueOrThrow({where:{id:f.connection.id}});
    expect(unknown).toMatchObject({refreshOutcomeUnknown:true,refreshClaimId:null,refreshLeaseExpiresAt:null,refreshStartedAt:null,accessTokenEncrypted:null,refreshTokenEncrypted:null});
    expect(unknown.revokedAt).not.toBeNull();
    await expect(service.recordingDownload(f.input)).rejects.toMatchObject({code:"zoom_connection_unavailable"});
    expect(calls).toBe(1);
  }));
  test("an expired started marker requires reconnect without making a provider request",scoped(async()=>{
    const f=await fixture();let calls=0;
    await db.zoomConnection.update({where:{id:f.connection.id},data:{refreshClaimId:crypto.randomUUID(),refreshLeaseExpiresAt:new Date(Date.now()-1000),refreshStartedAt:new Date(Date.now()-60_000)}});
    const service=new ZoomService({config:()=>config,api:api(async()=>{calls++;return tokens;})});
    await expect(service.recordingDownload(f.input)).rejects.toMatchObject({code:"zoom_connection_unavailable"});
    expect(calls).toBe(0);
    expect(await db.zoomConnection.findUniqueOrThrow({where:{id:f.connection.id}})).toMatchObject({refreshOutcomeUnknown:true,refreshClaimId:null,refreshStartedAt:null});
  }));
  test("a late refresh response cannot overwrite or revoke a later explicit OAuth grant",scoped(async()=>{
    const f=await fixture();let calls=0,release!:()=>void,entered!:()=>void;
    const wait=new Promise<void>(resolve=>{release=resolve;}),started=new Promise<void>(resolve=>{entered=resolve;});
    const service=new ZoomService({config:()=>config,api:api(async()=>{calls++;entered();await wait;return tokens;})});
    const first=service.recordingDownload(f.input);await started;
    try{
      await db.$transaction(async tx=>{await tx.$executeRaw`SET LOCAL lock_timeout='1s'`;await tx.zoomConnection.update({where:{id:f.connection.id},data:{accessTokenEncrypted:f.cipher.seal("reconnected-access"),refreshTokenEncrypted:f.cipher.seal("reconnected-rotation"),authorizedAt:new Date(),expiresAt:new Date(Date.now()+3600_000),refreshClaimId:null,refreshLeaseExpiresAt:null,refreshStartedAt:null,refreshOutcomeUnknown:false}});});
    }finally{release();}
    await expect(first).rejects.toMatchObject({code:"zoom_api_unavailable"});
    expect(await service.recordingDownload(f.input)).toMatchObject({accessToken:"reconnected-access"});
    const current=await db.zoomConnection.findUniqueOrThrow({where:{id:f.connection.id}});
    expect(current).toMatchObject({revokedAt:null,refreshOutcomeUnknown:false});
    expect(f.cipher.open(current.refreshTokenEncrypted!)).toBe("reconnected-rotation");expect(calls).toBe(1);
  }));
  test("a later token refresh does not hide an earlier deauthorization for the same OAuth grant",scoped(async()=>{
    const f=await fixture(),service=new ZoomService({config:()=>config,api:api(async()=>tokens)});
    const eventAt=new Date(f.connection.authorizedAt.getTime()+1);
    await service.recordingDownload(f.input);
    expect((await db.zoomConnection.findUniqueOrThrow({where:{id:f.connection.id}})).updatedAt.getTime()).toBeGreaterThan(eventAt.getTime());
    await service.revokeNotifiedConnection(f.connection.id,eventAt);
    expect((await db.zoomConnection.findUniqueOrThrow({where:{id:f.connection.id}})).revokedAt).not.toBeNull();
  }));
  test("the provider refresh runs after the SQL connection lock has been released",scoped(async()=>{
    const f=await fixture();let calls=0;
    const service=new ZoomService({config:()=>config,api:api(async()=>{
      calls++;
      await observer.$transaction(tx=>tx.$queryRaw`SELECT id FROM "ZoomConnection" WHERE id=${f.connection.id}::uuid FOR UPDATE NOWAIT`);
      return tokens;
    })});
    expect(await service.recordingDownload(f.input)).toMatchObject({accessToken:"refreshed-access"});
    const stored=await db.zoomConnection.findUniqueOrThrow({where:{id:f.connection.id}});
    expect(calls).toBe(1);
    expect(f.cipher.open(stored.refreshTokenEncrypted!)).toBe("refreshed-rotation");
    expect(stored).toMatchObject({authorizedAt:f.connection.authorizedAt,refreshClaimId:null,refreshLeaseExpiresAt:null,refreshStartedAt:null,refreshOutcomeUnknown:false});
  }));
});
