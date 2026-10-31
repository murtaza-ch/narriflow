import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeFile } from "node:fs/promises";
import WebSocket from "ws";
import { unstable_dev } from "wrangler";

const sizes=process.env.PROBE_SIZES?process.env.PROBE_SIZES.split(",").map(Number):[1000000,4000000,8000000,12000000,16000000,20*1024*1024,32000000,50000000,75000000,100000000];
assert(sizes.every(n=>Number.isSafeInteger(n)&&n>=1000000&&n<=100000000));
const prefix='{"data":[{"b64_json":"',suffix='"}]}';
const fixture=createServer(async(req,res)=>{
 const size=Number(new URL(req.url!,"http://fixture").searchParams.get("bytes"));
 if(!sizes.includes(size)){res.writeHead(400);res.end();return;}
 const base64Length=Math.ceil(size/3)*4;
 res.writeHead(200,{"content-type":"application/json","content-length":Buffer.byteLength(prefix)+base64Length+Buffer.byteLength(suffix),"x-request-id":"synthetic-memory-fixture"});
 res.write(prefix);
 let remaining=Math.floor(size/3)*4;
 const chunk="A".repeat(65536);
 while(remaining>0){const part=chunk.slice(0,Math.min(remaining,chunk.length));remaining-=part.length;if(!res.write(part))await once(res,"drain");}
 if(size%3===1)res.write("AA==");else if(size%3===2)res.write("AAA=");
 res.end(suffix);
});
fixture.listen(0,"127.0.0.1");await once(fixture,"listening");
const fixturePort=(fixture.address() as {port:number}).port;
function processSamples(){
 const rows=execFileSync("ps",["-axo","pid=,ppid=,rss=,comm="],{encoding:"utf8"}).trim().split("\n").map(line=>{const m=line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);return m?{pid:Number(m[1]),parent:Number(m[2]),rssBytes:Number(m[3])*1024,command:m[4]!}:null;}).filter(Boolean) as Array<{pid:number;parent:number;rssBytes:number;command:string}>;
 const children=new Set([process.pid]);for(let pass=0;pass<8;pass++)for(const row of rows)if(children.has(row.parent))children.add(row.pid);
 return rows.filter(row=>children.has(row.pid)&&row.command.endsWith("workerd"));
}
async function freePort(){const server=createServer();server.listen(0,"127.0.0.1");await once(server,"listening");const port=(server.address() as {port:number}).port;await new Promise<void>(resolve=>server.close(()=>resolve()));return port;}
async function inspector(port:number){
 const targets=await(await fetch(`http://127.0.0.1:${port}/json/list`)).json() as Array<{title:string;webSocketDebuggerUrl:string}>;
 const target=targets.find(t=>t.title.includes("image-provider-memory"))??targets[0];
 if(!target)return null;
 const socket=new WebSocket(target.webSocketDebuggerUrl);await once(socket,"open");
 const contexts:Array<{id:number;name:string}>=[];
 let nextId=0;const pending=new Map<number,{resolve:(v:unknown)=>void;reject:(e:unknown)=>void}>();
 socket.on("message",data=>{const message=JSON.parse(String(data));if(message.method==="Runtime.executionContextCreated")contexts.push(message.params.context);const call=pending.get(message.id);if(!call)return;pending.delete(message.id);message.error?call.reject(message.error):call.resolve(message.result);});
 return {target:{title:target.title},contexts,async call(method:string,params:Record<string,unknown>={}){const id=++nextId;return await new Promise((resolve,reject)=>{pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});},close(){socket.close();}};
}
const results:unknown[]=[];
try{
 for(const size of sizes){
  const inspectorPort=await freePort();
  const worker=await unstable_dev(fileURLToPath(new URL("./gates/image-provider-memory-probe.ts",import.meta.url)),{config:fileURLToPath(new URL("./gates/wrangler.image-provider-memory-probe.jsonc",import.meta.url)),local:true,ip:"127.0.0.1",port:0,inspectorPort,persist:false,logLevel:"error",vars:{FIXTURE_URL:`http://127.0.0.1:${fixturePort}/?bytes=${size}`,TEST_BYTES:String(size)},experimental:{disableExperimentalWarning:true,disableDevRegistry:true,watch:false}});
  let debuggerClient:Awaited<ReturnType<typeof inspector>>=null;
  try{
   const warm=await worker.fetch("/__warmup");assert.equal(warm.status,200);await warm.arrayBuffer();
   debuggerClient=await inspector(inspectorPort).catch(()=>null);
   await debuggerClient?.call("Runtime.enable");
   const marker=await debuggerClient?.call("Runtime.evaluate",{expression:"globalThis.__imageProviderMemoryProbe",returnByValue:true,contextId:debuggerClient.contexts[0]?.id}) as {result?:{value?:unknown}}|undefined;
   assert.equal(marker?.result?.value,"narriflow-image-provider-memory-probe","Inspector must measure this exact probe isolate");
   const beforeHeap=await debuggerClient?.call("Runtime.getHeapUsage").catch(error=>({unsupported:error}));
   const baseline=processSamples();let peak=baseline.reduce((sum,row)=>sum+row.rssBytes,0);
   const timer=setInterval(()=>{peak=Math.max(peak,processSamples().reduce((sum,row)=>sum+row.rssBytes,0));},25);
   const started=performance.now();let response:Response|undefined,body:unknown,error:unknown;
   try{response=await worker.fetch("/");body=await response.json();}catch(value){error=String(value).slice(0,500);}finally{clearInterval(timer);}
   const afterHeap=await debuggerClient?.call("Runtime.getHeapUsage").catch(value=>({unsupported:value}));
   const version=baseline[0]?execFileSync(baseline[0].command,["--version"],{encoding:"utf8"}).trim():"unknown";
   const result={workerdVersion:version,inspectorMarkerVerified:true,inspectorTarget:debuggerClient?.target,inputBytes:size,encodedBytes:Math.ceil(size/3)*4,status:response?.status??null,body,error,wallMs:Math.round(performance.now()-started),baselineWorkerdRssBytes:baseline.reduce((sum,row)=>sum+row.rssBytes,0),peakWorkerdRssBytes:peak,beforeHeap,afterHeap};
   results.push(result);process.stdout.write(`${JSON.stringify(result)}\n`);
  }finally{debuggerClient?.close();await worker.stop();}
 }
}finally{await new Promise<void>(resolve=>fixture.close(()=>resolve()));await writeFile(process.env.PROBE_OUTPUT??"/tmp/narriflow-image-provider-memory.json",JSON.stringify({runtime:"local-workerd",limitsUnchanged:true,processRssIsNotIsolateMemory:true,heapAfterIsNotPeak:true,noEdgeDeployPerformed:true,externalProviderRequests:0,nodeVersion:process.versions.node,results},null,2)+"\n");}
