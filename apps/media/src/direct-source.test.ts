import { expect,test } from "bun:test";
import { mkdtemp,readFile,rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { downloadDirectSource } from "./direct-source";
import { guardedFetch,type PinnedTransport } from "./outbound-transport";

test("a rate-limited Drive source retries and drops its scoped credential across an origin redirect",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"native-direct-")),seen:Array<string|null>=[];let attempts=0;
 const transport:PinnedTransport=async(url,request)=>{
  seen.push(request.headers.get("authorization"));attempts++;
  if(attempts===1)return new Response(JSON.stringify({error:{errors:[{reason:"userRateLimitExceeded"}]}}),{status:403});
  if(url.hostname==="www.googleapis.com")return new Response(null,{status:302,headers:{location:"https://cdn.example/source.mp4"}});
  return new Response("verified-media",{headers:{"content-type":"video/mp4","content-length":"14"}});
 };
 try{
  const path=join(directory,"source.bin");
  const result=await downloadDirectSource({provider:"drive",url:"https://www.googleapis.com/drive/v3/files/drive-file-0001?alt=media&supportsAllDrives=true",authorization:"Bearer scoped-only"},path,{
   fetch:(url,options)=>guardedFetch(url,{...options,transport,resolver:async()=>[{address:"8.8.8.8",family:4}]}),delay:async()=>{}});
  expect(await readFile(path,"utf8")).toBe("verified-media");expect(result).toEqual({byteLength:14,contentType:"video/mp4"});
  expect(seen).toEqual(["Bearer scoped-only","Bearer scoped-only",null]);
 }finally{await rm(directory,{recursive:true,force:true});}
});

test("a chunked source exceeding its bound is refused once and its partial file is removed",async()=>{
 const directory=await mkdtemp(join(tmpdir(),"native-direct-cap-"));let calls=0;
 try{
  const path=join(directory,"source.bin");
  await expect(downloadDirectSource({provider:"rss",url:"https://feed.example/audio",authorization:null},path,{maxBytes:3,
   fetch:async()=>{calls++;return new Response("oversized",{headers:{"content-type":"audio/mpeg"}});},delay:async()=>{}})).rejects.toMatchObject({code:"remote_media_too_large",retryable:false});
  expect(calls).toBe(1);await expect(readFile(path)).rejects.toMatchObject({code:"ENOENT"});
 }finally{await rm(directory,{recursive:true,force:true});}
});
