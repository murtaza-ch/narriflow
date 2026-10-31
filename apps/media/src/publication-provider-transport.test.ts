import {expect,test} from "bun:test";
import {classifyPublicationRequest,createPublicationProviderTransport} from "./publication-provider-transport";
test("a terminal Worker decision opens no provider request, even after an earlier submission checkpoint",async()=>{
 let calls=0;
 const transport=createPublicationProviderTransport({platform:"linkedin",command:async()=>({kind:"settled",outcome:"needs_attention"}),fetch:(async()=>{calls++;return new Response("{}");}) as typeof fetch});
 await expect(transport.fetch("https://api.linkedin.com/rest/posts",{method:"POST",body:"{}"})).rejects.toThrow("publication_provider_authority_lost");expect(calls).toBe(0);
});
test("provider origin and method policy is checked before requesting mutation authority",async()=>{
 let calls=0;
 const transport=createPublicationProviderTransport({platform:"youtube_shorts",command:async()=>{calls++;return {kind:"recorded"};}});
 await expect(transport.fetch("https://attacker.example/upload",{method:"POST"})).rejects.toThrow("publication_provider_origin_invalid");
 await expect(transport.fetch("http://www.googleapis.com/upload",{method:"POST"})).rejects.toThrow("publication_provider_origin_invalid");
 expect(calls).toBe(0);
 expect(classifyPublicationRequest("youtube_shorts",new URL("https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable"),"POST","{}")).toMatchObject({operation:"initialize",purpose:"primary_media"});
 expect(classifyPublicationRequest("youtube_shorts",new URL("https://www.googleapis.com/upload/youtube/v3/thumbnails/set?uploadType=media"),"POST",new Blob())).toMatchObject({operation:"upload",purpose:"thumbnail"});
});
test("the compiled provider transport requires an explicit fresh recorded admission for each HTTP request",async()=>{
 const commands:string[]=[],requests:string[]=[];
 const transport=createPublicationProviderTransport({platform:"x",command:async command=>{commands.push(command.kind);return {kind:"recorded"};},fetch:(async(raw)=>{requests.push(String(raw));return new Response('{"ok":true}');}) as typeof fetch});
 await transport.fetch("https://api.x.com/2/users/me");await transport.fetch("https://api.x.com/2/tweets",{method:"POST",body:"{}"});expect(commands).toEqual(["provider_call","provider_call"]);expect(requests).toHaveLength(2);
});

test("manual reconciliation classifies only protocol-defined TikTok POST and empty YouTube PUT status requests as reads",()=>{
 expect(classifyPublicationRequest("tiktok",new URL("https://open.tiktokapis.com/v2/post/publish/status/fetch/"),"POST",'{"publish_id":"existing"}')).toMatchObject({operation:"read"});
 expect(classifyPublicationRequest("youtube_shorts",new URL("https://www.googleapis.com/upload/resumable/one"),"PUT",undefined,{"Content-Range":"bytes */100"})).toMatchObject({operation:"read"});
 expect(classifyPublicationRequest("youtube_shorts",new URL("https://www.googleapis.com/upload/resumable/one"),"PUT",new Blob(["bytes"]),{"Content-Range":"bytes 0-4/100"})).toMatchObject({operation:"upload"});
});
