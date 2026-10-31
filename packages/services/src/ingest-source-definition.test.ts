import { expect,test } from "bun:test";
import { resolveIngestSourceDefinition } from "./ingest-source-definition";

test("a sealed Picker credential is resolved only by the Worker port into the fixed Drive media read",async()=>{
 const seen:string[]=[];const job={jobType:"drive_import" as const,projectId:"60000000-0000-4000-8000-000000000001",payload:{fileId:"drive-file-0001",fileName:"picked.mp4",acquisition:{audioPolicy:"required"}},sourceCredential:"sealed-worker-only"};
 const source=await resolveIngestSourceDefinition(job,{openDriveCredential:sealed=>{seen.push(sealed);return "scoped-drive-read";}});
 expect(seen).toEqual(["sealed-worker-only"]);
 expect(source).toMatchObject({kind:"direct_source",mediaIdentity:{provider:"drive",mediaId:"drive-file-0001"},source:{provider:"drive",url:"https://www.googleapis.com/drive/v3/files/drive-file-0001?alt=media&supportsAllDrives=true",authorization:"Bearer scoped-drive-read"}});
 expect(job.sourceCredential).toBe("sealed-worker-only");
});

test("RSS resolves only its server-frozen enclosure and keeps a stable upstream identity",async()=>{
 const job={jobType:"rss_import" as const,projectId:"60000000-0000-4000-8000-000000000001",sourceCredential:null,payload:{rssUrl:"https://feed.example/rss",episode:{id:"episode1",enclosureUrl:"https://cdn.example/episode.mp3"},acquisition:{audioPolicy:"pending_pack"}}};
 const first=await resolveIngestSourceDefinition(job,{}),replay=await resolveIngestSourceDefinition(job,{});
 expect(first).toEqual(replay);expect(first).toMatchObject({kind:"direct_source",mediaIdentity:{provider:"rss"},source:{provider:"rss",url:"https://cdn.example/episode.mp3",authorization:null}});
});

test("Zoom resolves the exact admitted recording through a Worker-only read-credential port",async()=>{
 const projectId="60000000-0000-4000-8000-000000000001",connectionId="60000000-0000-4000-8000-000000000002",seen:unknown[]=[];
 const job={jobType:"zoom_import" as const,projectId,sourceCredential:null,payload:{connectionId,meetingUuid:"meeting/one",recordingId:"recording1",acquisition:{audioPolicy:"required"}}};
 const result=await resolveIngestSourceDefinition(job,{zoomRecordingDownload:async input=>{seen.push(input);return {downloadUrl:"https://us02web.zoom.us/rec/download/scoped",accessToken:"scoped-zoom-read"};}});
 expect(seen).toEqual([{projectId,connectionId,meetingUuid:"meeting/one",recordingId:"recording1"}]);
 expect(result).toMatchObject({kind:"direct_source",mediaIdentity:{provider:"zoom"},source:{provider:"zoom",url:"https://us02web.zoom.us/rec/download/scoped",authorization:"Bearer scoped-zoom-read"}});
});

test("Dropbox uses its existing direct-download normalization while the original identity stays frozen",async()=>{
 const job={jobType:"link_import" as const,projectId:"60000000-0000-4000-8000-000000000001",sourceCredential:null,payload:{provider:"dropbox",url:"https://www.dropbox.com/scl/fi/abc/media.mp4?rlkey=read-only&dl=0",acquisition:{audioPolicy:"none"}}};
 const result=await resolveIngestSourceDefinition(job,{});
 expect(result).toMatchObject({kind:"direct_source",mediaIdentity:{provider:"direct"},source:{provider:"direct",url:"https://www.dropbox.com/scl/fi/abc/media.mp4?rlkey=read-only&dl=1",authorization:null}});
});

test("an upload pin resolves only its verified object identity and measured MIME bound",async()=>{
 const job={jobType:"upload_finalize" as const,projectId:"60000000-0000-4000-8000-000000000001",sourceCredential:null,payload:{uploadSessionId:"60000000-0000-4000-8000-000000000003",storageKey:"uploads/session/source.mp4",verifiedEtag:'"verified-etag"',verifiedSizeBytes:6*1024**3,verifiedContentType:"video/mp4",acquisition:{audioPolicy:"pending_pack"}}};
 expect(await resolveIngestSourceDefinition(job,{})).toEqual({kind:"upload_source",mediaIdentity:{provider:"upload",mediaId:job.payload.uploadSessionId},source:{storageKey:"uploads/session/source.mp4",etag:'"verified-etag"',byteLength:6*1024**3,contentType:"video/mp4"}});
});
