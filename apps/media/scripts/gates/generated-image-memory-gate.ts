import { createServer } from "node:http";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeGeneratedImage } from "../../src/generated-image";

const LIMIT = 4 * 1024 ** 3;
if (process.argv[2] === "--child") {
  const size = Number(process.argv[3]), url = new URL(process.argv[4]!);
  if (![20 * 1024 * 1024, 100000000].includes(size) || url.protocol !== "http:" || url.hostname !== "127.0.0.1") throw new Error("fixture_invalid");
  const work = await mkdtemp(join(tmpdir(), "generated-native-memory-"));
  let calls = 0, decoded: { byteLength: number; sha256: string } | undefined;
  try {
    const result = await executeGeneratedImage({kind:"generated_image",mode:"generate",jobId:crypto.randomUUID(),requestId:crypto.randomUUID(),inputHash:"a".repeat(64),prompt:"Synthetic bounded resource gate",aspectRatio:"1:1",style:"editorial",model:"synthetic-memory-fixture",quality:"medium",maxOutputBytes:size}, {
      work, outputPath:join(work,"validated.png"), binaryArtifactId:crypto.randomUUID(),apiKey:"synthetic-gate-key",signal:AbortSignal.timeout(120000),
      fetch:async (requested,init) => {
        if (String(requested)!=="https://api.openai.com/v1/images/generations" || init?.method!=="POST" || init.redirect!=="error") throw new Error("fixed_origin_changed");
        calls++;
        return fetch(url,{signal:init.signal});
      },
      decoded:bytes => { decoded={byteLength:bytes.byteLength,sha256:createHash("sha256").update(bytes).digest("hex")}; },
    });
    const zero = Buffer.alloc(1024*1024),expected=createHash("sha256");
    for(let left=size;left>0;left-=Math.min(left,zero.length)) expected.update(zero.subarray(0,Math.min(left,zero.length)));
    const peakRssBytes=process.resourceUsage().maxRSS*1024;
    if (calls!==1 || decoded?.byteLength!==size || decoded.sha256!==expected.digest("hex") || result.outcome!=="failed" || result.code!=="generated_media_output_invalid" || peakRssBytes>=LIMIT || (await readdir(work)).length!==0) throw new Error("native_resource_gate_failed");
    console.log(JSON.stringify({size, calls, decoded, result:{outcome:result.outcome,code:result.code}, peakRssBytes, nativeMemoryLimitBytes:LIMIT, syntheticNonImageRejected:true, usableAssetPublished:false, platform:process.platform, bun:process.versions.bun}));
  } finally { await rm(work,{recursive:true,force:true}); }
} else {
  const results:unknown[]=[];
  for(const size of [20*1024*1024,100000000]) {
    const encodedLength=4*Math.ceil(size/3),padding=(3-size%3)%3;

    const server=createServer((_request,response)=>{
      response.writeHead(200,{"Content-Type":"application/json","x-request-id":"synthetic-native-memory"});
      void (async()=>{
        response.write('{"data":[{"b64_json":"');
        const chunk=Buffer.from("A".repeat(1024*1024));
        for(let left=encodedLength-padding;left>0;){
          const count=Math.min(left,chunk.length);left-=count;
          if(!response.write(chunk.subarray(0,count)))await once(response,'drain');
        }
        response.end("=".repeat(padding)+'"}]}');
      })().catch(()=>response.destroy());
    });
    server.listen(0,"127.0.0.1");await once(server,'listening');
    const address=server.address();if(!address||typeof address==='string')throw new Error("fixture_invalid");
    try {
      const {stdout}=await promisify(execFile)(process.execPath,[fileURLToPath(import.meta.url),"--child",String(size),`http://127.0.0.1:${address.port}`],{env:{PATH:process.env.PATH},maxBuffer:65536,timeout:150000});
      results.push(JSON.parse(stdout));
    } finally { server.closeAllConnections();server.close(); }
  }
  console.log(JSON.stringify({gate:"native-generated-image-decode",results},null,2));
}
