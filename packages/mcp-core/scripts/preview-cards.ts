/** Local design harness: every App card, in every state, behind a fake MCP Apps host.
 * Run `bun run --cwd packages/mcp-core build:apps` first. CARD_PREVIEW_VIDEO is an
 * optional path to an mp4. Fixtures only: this never reaches an API. */
import { narriflowAppHtml } from "../src/mcp-apps/v2/document";

const operation = { kind: "export", id: "export-1" };
const clip = { clipId: "clip-1", projectId: "project-1", editorRevision: 0, title: "How Great Culture Gets Built", status: "detected", startSec: 2366.354, endSec: 2426.914, durationSec: 60.6,
  hookText: "Having very high convictions, extreme clarity on what you are setting out to do.", reasoning: "This is a strong founder lesson: clarity attracts talent, and conviction doesn’t mean rigidity. It has a clear setup and payoff.", category: "tutorial",
  platformFit: ["tiktok", "youtube_shorts", "instagram_reels"], scores: { virality: 77, hookStrength: 84, emotionalIntensity: 39, storyCompleteness: 85, pacing: 90, durationOptimality: 99 }, hasPreview: true,
  transcriptExcerpt: "Um, one thing is having very high convictions, extreme clarity on what you are setting out to do. And even if what you set out to do sounds crazy to most people, the fact that you are willing to take that approach is very appealing to some set of people.", reviewUrl: "https://narriflow.example/studio" };
const queued = { export: { exportId: "export-1", status: "queued", progress: 0, resolution: "720p", editorRevision: 0, variants: [{ aspectRatio: "1:1" }] }, operation };
const status = (state: string, progress: number, stage = "rendering", kind = "export") => ({ operation: { kind, id: `${kind}-1` }, state, stage, progress, notices: [], failureCode: null, reviewUrl: "https://narriflow.example/project",
  items: kind === "export" ? [{ kind: "variant", id: "v", state: state === "completed" ? "completed" : "working", failureCode: null }] : [],
  results: { projectId: "project-1", clipIds: [], exportId: kind === "export" ? "export-1" : null } });
const files = { exportId: "export-1", variants: [{ variantId: "v", aspectRatio: "1:1", resolution: "720p", watermark: false, fileName: "clip.mp4", sizeBytes: 5_991_195, downloadUrl: "/video.mp4" }], subtitles: [] };
const titles = ["The Last Heart-Pounding Moment", "Would You Trust Your Kids In an AI World?", "Why People Don’t Take Moonshots", "Why he wants more pushback, not more yes-men", "The version of me that died"];
const clips = { items: titles.map((title, index) => ({ title, durationSec: 39 + index * 6, category: ["emotional", "insight"][index % 2], scores: { virality: 87 - index * 3 }, reviewUrl: "https://narriflow.example/studio" })), nextCursor: null };
const intent = { caption: "Clarity attracts talent. Conviction doesn’t mean rigidity.\n\n#founders #startups", platform: "tiktok", aspectRatio: "9:16", resolution: "1080p", expectedEditorRevision: 4, scheduledFor: "2026-11-09T14:00:00Z", deliveryMode: "direct", providerSettings: { disableComments: true } };

interface Scenario { view: "upload" | "progress" | "clip-review" | "publication-confirmation"; label: string; data: unknown; meta?: unknown; tools?: Record<string, unknown[]>; }
const scenarios: Record<string, Scenario> = {
  "export-live": { view: "progress", label: "Export: queued, then live, then finished", data: queued, tools: { narriflow_get_operation: [status("working", 0), status("working", 0.45), status("completed", 1)], narriflow_get_export_download: [files] } },
  "export-replay": { view: "progress", label: "Export: stale 0% result on a finished export", data: queued, tools: { narriflow_get_operation: [status("completed", 1)], narriflow_get_export_download: [files] } },
  "generation-live": { view: "progress", label: "Clips: stage by stage", data: { projectId: "project-1", operation: { kind: "generation", id: "generation-1" }, status: "accepted" }, tools: { narriflow_get_operation: [status("working", 0.2, "transcribing", "generation"), status("working", 0.5, "detecting", "generation"), status("working", 0.8, "rendering", "generation"), status("completed", 1, "rendering", "generation")], narriflow_list_clips: [clips] } },
  failed: { view: "progress", label: "Export: failed", data: status("failed", 0.6) },
  clip: { view: "clip-review", label: "Clip review with in-card export", data: { clip }, meta: { workspaceId: "w", previewMediaUrl: "/video.mp4", previewStartSec: clip.startSec, previewDurationSec: 61 }, tools: { narriflow_create_clip_export: [queued], narriflow_get_operation: [status("working", 0.4), status("completed", 1)], narriflow_get_export_download: [files] } },
  upload: { view: "upload", label: "Upload", data: {}, meta: { uploadContext: { workspaceId: "w", generationContext: { contentPack: { defaultAspectRatio: "9:16", clipLengthPreset: "auto", captionPreset: "brand_default" } } } } },
  uploaded: { view: "upload", label: "Upload received", data: {}, meta: { uploadTransfer: { outcome: "queued_for_ingest", projectId: "project-1" } } },
  publish: { view: "publication-confirmation", label: "Confirm a post", data: { accountDisplayName: "Narriflow demo", intent } },
  scheduled: { view: "publication-confirmation", label: "Post scheduled", data: { status: "scheduled" } },
};
const video = process.env.CARD_PREVIEW_VIDEO;
const page = (dark: boolean) => `<!doctype html><meta charset="utf-8"><title>Cards</title><style>body{margin:0;padding:20px;background:${dark ? "#262626" : "#e9eaec"};color:${dark ? "#ddd" : "#333"};font:12px system-ui}main{display:grid;grid-template-columns:repeat(auto-fill,minmax(min(100%,560px),1fr));gap:18px;align-items:start}iframe{width:100%;height:320px;border:0;border-radius:12px;display:block}p{margin:0 0 6px}</style>
<main>${Object.entries(scenarios).map(([id, scenario]) => `<div><p>${scenario.label}</p><iframe id="${id}" src="/card/${id}" title="${scenario.label}"></iframe></div>`).join("")}</main>
<script>const scenarios=${JSON.stringify(scenarios)},theme=${JSON.stringify(dark ? "dark" : "light")},calls={};
addEventListener("message",({data:m,source})=>{const frame=[...document.querySelectorAll("iframe")].find(f=>f.contentWindow===source);if(!frame||!m||m.jsonrpc!=="2.0")return;const s=scenarios[frame.id],send=x=>source.postMessage({jsonrpc:"2.0",...x},"*");
if(m.method==="ui/initialize")return send({id:m.id,result:{protocolVersion:"2026-01-26",hostInfo:{name:"preview",version:"1"},hostCapabilities:{openLinks:{},serverTools:{}},hostContext:{theme}}});
if(m.method==="ui/notifications/initialized"){send({method:"ui/notifications/tool-input",params:{arguments:{workspaceId:"w"}}});send({method:"ui/notifications/tool-result",params:{structuredContent:{data:s.data},_meta:s.meta??{}}});return}
if(m.method==="ui/notifications/size-changed"){frame.style.height=m.params.height+"px";return}
if(m.method==="tools/call"){const key=frame.id+m.params.name,list=(s.tools??{})[m.params.name]??[],i=calls[key]=(calls[key]??-1)+1,data=list[Math.min(i,list.length-1)];setTimeout(()=>send({id:m.id,result:data?{structuredContent:{data}}:{isError:true,structuredContent:{}}}),150);return}
if(m.method==="ui/open-link"){send({id:m.id,result:{}});return}if(m.id!==undefined)send({id:m.id,result:{}})});</script>`;

Bun.serve({ port: Number(process.env.PORT ?? 4311), fetch(request) {
  const url = new URL(request.url);
  if (url.pathname === "/video.mp4" && video) return new Response(Bun.file(video), { headers: { "content-type": "video/mp4" } });
  const id = url.pathname.match(/^\/card\/(.+)$/)?.[1];
  const scenario = id ? scenarios[id] : undefined;
  if (scenario) return new Response(narriflowAppHtml(scenario.view, "https://narriflow.example"), { headers: { "content-type": "text/html" } });
  return new Response(page(url.searchParams.get("theme") !== "light"), { headers: { "content-type": "text/html" } });
} });
