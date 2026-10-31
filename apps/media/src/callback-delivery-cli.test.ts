import { expect,test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp,readFile,rm,symlink,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const eventId="60000000-0000-4000-8000-000000000001",workspaceId="60000000-0000-4000-8000-000000000002";
async function run(bodyPath:string,outputPath:string,body:Buffer){
 const command={kind:"signed_notification",deliveryId:"60000000-0000-4000-8000-000000000003",eventId,workspaceId,inputHash:"a".repeat(64),url:"https://127.0.0.1/private-NO-LOG",body:{source:"notification_body",sha256:createHash("sha256").update(body).digest("hex"),byteLength:body.length},headers:{"content-type":"application/json","user-agent":"Narriflow-Callbacks/1","webhook-id":eventId,"webhook-timestamp":String(Math.floor(Date.now()/1000)),"webhook-signature":`v1,${Buffer.alloc(32).toString("base64")}`}};
 const child=Bun.spawn([process.execPath,new URL("./callback-delivery-cli.ts",import.meta.url).pathname],{stdin:"pipe",stdout:"pipe",stderr:"pipe",env:{...process.env,DATABASE_URL:"postgres://poison.invalid/never",DIRECT_URL:"postgres://poison.invalid/never",UPSTASH_REDIS_REST_URL:"https://poison.invalid/never"}});
 child.stdin.write(JSON.stringify({command,bodyPath,outputPath}));child.stdin.end();
 const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);return {code,stdout,stderr};
}
test("the poisoned-env native CLI records only a bounded failed receipt for an unsafe endpoint",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"narriflow-callback-cli-"));
 try{const body=Buffer.from(JSON.stringify({id:eventId,workspaceId})),bodyPath=join(directory,"body.json"),outputPath=join(directory,"receipt.json");await writeFile(bodyPath,body,{mode:0o400});
  const result=await run(bodyPath,outputPath,body);expect(result.code).toBe(0);expect(JSON.parse(result.stdout)).toEqual({completed:true});expect(result.stderr).toBe("");
  const receipt=JSON.parse(await readFile(outputPath,"utf8"));expect(receipt).toMatchObject({status:null,errorCode:"remote_url_unsafe",eventId,workspaceId});expect(JSON.stringify(receipt)).not.toContain("private-NO-LOG");
 }finally{await rm(directory,{recursive:true,force:true});}
});
test("a source leaf symlink cannot become the POST body or leak local paths in diagnostics",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"narriflow-callback-link-"));
 try{const body=Buffer.from(JSON.stringify({id:eventId,workspaceId})),source=join(directory,"source.json"),link=join(directory,"linked.json"),output=join(directory,"receipt.json");await writeFile(source,body);await symlink(source,link);
  const result=await run(link,output,body);expect(result.code).toBe(1);expect(result.stdout).toBe("");expect(JSON.parse(result.stderr)).toMatchObject({errorCode:"outbound_delivery_failed"});expect(result.stderr).not.toContain(directory);expect(result.stderr).not.toContain("poison.invalid");
 }finally{await rm(directory,{recursive:true,force:true});}
});
