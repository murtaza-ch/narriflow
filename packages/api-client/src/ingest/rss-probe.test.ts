import { expect, test } from "bun:test";
import { ApiScope } from "../core/scope";
import { createApiTransport } from "../core/transport";
import { errorResponse, fakeFetch, jsonResponse, USER, WORKSPACE_A, WORKSPACE_B } from "../core/test-helpers";
import { createIngestActions } from "./mutations";

const actor = { userId: USER, workspaceId: WORKSPACE_A };
const jobId = "50000000-0000-4000-8000-000000000001";
const result = { title: "Podcast", episodes: [{id:"episode1", title:"First",enclosureUrl:"https://cdn.example/one.mp3"}], finalUrl: "https://feed.example/feed.xml", etag: null, lastModified: null, notModified: false };
function setup(...handlers: Parameters<typeof fakeFetch>) {
  const scope = new ApiScope(); scope.setUser(USER); scope.selectWorkspace(WORKSPACE_A);
  const fake = fakeFetch(...handlers);
  const transport = createApiTransport({ baseUrl: "https://api.example.test", scope, getToken: async () => "session", fetch: fake.fetch });
  return { scope, ...fake, actions: createIngestActions(transport, actor) };
}
test("preview waits for the actual native result before exposing episodes", async () => {
  const f = setup(() => jsonResponse({jobId,status:"pending"},{status:202}), () => jsonResponse({jobId,status:"pending",result:null}), () => jsonResponse({jobId,status:"ready",result}));
  expect(await f.actions.previewRss({rssUrl:"https://feed.example/feed.xml"})).toEqual(result);
  expect(f.calls.map(call=>new URL(call.url).pathname)).toEqual(["/api/ingest/rss/preview",`/api/ingest/rss/probes/${jobId}`,`/api/ingest/rss/probes/${jobId}`]);
  for(const call of f.calls) expect(call.headers.get("X-Workspace-Id")).toBe(WORKSPACE_A);
});
test("a Workspace change stops pending checks before any new Workspace can receive the result", async () => {
  const f = setup(() => jsonResponse({jobId,status:"pending"},{status:202}), () => { setTimeout(()=>f.scope.selectWorkspace(WORKSPACE_B),20); return jsonResponse({jobId,status:"pending",result:null}); });
  await expect(f.actions.previewRss({rssUrl:"https://feed.example/feed.xml"})).rejects.toMatchObject({code:"scope_changed"});
  expect(f.calls).toHaveLength(2);
});
test("an import reuses its original commit identity after a pending authoritative feed check", async () => {
  const input = {rssUrl:"https://feed.example/feed.xml",episodeIds:["episode1"],commitToken:"70000000-0000-4000-8000-000000000001",contentPack:null,languageCode:"en"};
  const f = setup(()=>errorResponse(409,"rss_probe_pending",{details:{jobId}}),()=>jsonResponse({jobId,status:"ready",result}),()=>jsonResponse({project:{id:"project1"},queuedJobId:"ingest1"},{status:202}));
  await f.actions.importRss(input as Parameters<typeof f.actions.importRss>[0]);
  expect(f.calls[0]!.init.body).toBe(f.calls[2]!.init.body);
});
