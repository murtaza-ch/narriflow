import { App } from "@modelcontextprotocol/ext-apps";
import { waitForUploadAcceptance, notifyUploadAcceptance } from "./upload-progress";
import { narriflowProgressRequest } from "./progress";
import { createPublicationDecision, isPublicationDeclined } from "./publication-decision";

const app = new App({ name: "Narriflow", version: "1.0.0" });
const view = document.body.dataset.view;
const status = document.querySelector<HTMLParagraphElement>("#status")!;
const details = document.querySelector<HTMLDivElement>("#details")!;
const action = document.querySelector<HTMLButtonElement>("#action")!;
const secondary = document.querySelector<HTMLButtonElement>("#secondary")!;
const file = document.querySelector<HTMLInputElement>("#file")!;
const progress = document.querySelector<HTMLProgressElement>("#progress")!;
let payload: Record<string, unknown> = {};
let metadata: Record<string, unknown> = {};
let arguments_: Record<string, unknown> = {};
let uploadContext: Record<string, unknown> = {};
let busy = false;
const publicationDecision = createPublicationDecision();
let publicationReceipt: unknown;

function text(value: unknown) { return typeof value === "string" || typeof value === "number" ? String(value) : ""; }
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
function render(result: { structuredContent?: unknown; _meta?: Record<string, unknown>; isError?: boolean }) {
  if (result.isError) throw new Error("Narriflow could not complete this action. Open Narriflow to review the request.");
  const structured = record(result.structuredContent);
  payload = record(structured.data ?? structured);
  metadata = record(result._meta);
  if (metadata.uploadContext) uploadContext = record(metadata.uploadContext);
  details.replaceChildren();
  const source = record(payload.export ?? payload.project ?? payload.clip ?? payload.publication ?? payload.intent ?? payload);
  const facts = { ...source, ...record(source.scores), ...record(payload.progress), ...(payload.accountDisplayName ? { destination: payload.accountDisplayName } : {}) };
  for (const [label, value] of Object.entries(facts)) {
    if (value === null || value === undefined || typeof value === "object") continue;
    const row = document.createElement("p");
    const name = document.createElement("strong");
    name.textContent = `${label.replace(/([A-Z])/g, " $1")}: `;
    row.append(name, document.createTextNode(text(value)));
    details.append(row);
  }
  const providerSettings = record(source.providerSettings);
  if (Object.keys(providerSettings).length) {
    const settings = document.createElement("pre");
    settings.textContent = JSON.stringify(providerSettings, null, 2);
    details.append(settings);
  }
  const previewUrl = text(metadata.previewMediaUrl);
  if (view === "clip-review" && previewUrl) {
    const player = document.createElement("video");
    player.controls = true;
    player.preload = "none";
    player.setAttribute("aria-label", "Selected clip preview");
    player.style.maxWidth = "100%";
    player.src = previewUrl;
    const clipStart = Number(source.startSec);
    const clipEnd = Number(source.endSec);
    const previewStart = Number(metadata.previewStartSec ?? 0);
    const localStart = Math.max(0, clipStart - previewStart);
    const localEnd = clipEnd - previewStart;
    if (Number.isFinite(localStart)) player.addEventListener("loadedmetadata", () => { player.currentTime = Math.min(localStart, player.duration || localStart); }, { once: true });
    if (Number.isFinite(localEnd) && localEnd > localStart) player.addEventListener("timeupdate", () => { if (player.currentTime >= localEnd) player.pause(); });
    details.prepend(player);
  }
  status.textContent = view === "publication-confirmation" ? "Review the exact post, destination and time before confirming." : "Choose an action below.";
  action.disabled = busy;
  secondary.disabled = busy;
  renderPublicationDecision();
}

function renderPublicationDecision() {
  if (view !== "publication-confirmation") return;
  action.disabled = busy || !publicationDecision.canConfirm;
  secondary.disabled = busy || !publicationDecision.canDecline;
  if (publicationDecision.state === "scheduled") status.textContent = "Publication scheduled. Open Narriflow to inspect its status.";
  if (publicationDecision.state === "declined") status.textContent = "Declined. No post was scheduled.";
  if (publicationDecision.state === "uncertain") {
    status.textContent = "The scheduling response was lost. A post may already be scheduled. Retry the same request or inspect its status in Narriflow.";
    action.textContent = "Retry the same scheduling request";
  }
}

async function call(name: string, args: Record<string, unknown>) {
  const result = await app.callServerTool({ name, arguments: args });
  if (result.isError) throw new Error("Narriflow could not complete the action. Check the request in Narriflow.");
  return result;
}
function link() {
  const source = record(payload.export ?? payload.project ?? payload.clip ?? payload.publication ?? payload);
  const publicUrl = text(payload.reviewUrl ?? payload.handoffUrl ?? payload.confirmationUrl ?? source.reviewUrl ?? source.webUrl);
  if (publicUrl) return publicUrl;
  const projectId = text(record(metadata.uploadTransfer).projectId);
  const operation = record(metadata["narriflow/operation"]);
  const ownedProjectId = projectId || text(operation.projectId);
  if (!ownedProjectId || !document.body.dataset.appOrigin) return "";
  const path = `/projects/${encodeURIComponent(ownedProjectId)}`;
  return `${document.body.dataset.appOrigin}${operation.domainKind === "export" && operation.clipId && operation.domainId ? `${path}/clips/${encodeURIComponent(text(operation.clipId))}/exports/${encodeURIComponent(text(operation.domainId))}` : path}`;
}
async function openLink() { const url = link(); if (url) await app.openLink({ url }); }

async function acceptedUpload(result: Awaited<ReturnType<typeof call>>) {
  render(result);
  const capabilities = app.getHostCapabilities();
  const notified = await notifyUploadAcceptance(result, uploadContext, document.body.dataset.appOrigin ?? "", {
    updateModelContext: capabilities?.updateModelContext ? (params) => app.updateModelContext(params) : undefined,
    sendMessage: capabilities?.message ? (params) => app.sendMessage(params) : undefined,
  });
  status.textContent = notified ? "Upload received. Narriflow is processing your video." : `Upload received. Ask your assistant to check project ${text(record(result._meta?.uploadTransfer).projectId)} with narriflow_get_project, or open Narriflow.`;
}

async function upload() {
  const source = file.files?.[0];
  if (!source) throw new Error("Choose a video or audio file first.");
  const context = uploadContext;
  const sourceFingerprint = JSON.stringify([source.name, source.size, source.type, source.lastModified]);
  const input = { ...context, title: context.title ?? source.name, source: { fileName: source.name, sizeBytes: source.size, contentType: source.type || "video/mp4", browserFingerprint: sourceFingerprint } };
  const opened = await call("narriflow_upload_open", input);
  const state = record(opened._meta?.uploadTransfer);
  const sessionId = text(state.sessionId);
  const awaitAcceptance = (result: Awaited<ReturnType<typeof call>>) => waitForUploadAcceptance(result, {
    readStatus: () => call("narriflow_upload_status", { workspaceId: context.workspaceId, clientIdempotencyKey: context.clientIdempotencyKey, sessionId, browserFingerprint: sourceFingerprint }),
  });
  if (state.outcome === "queued_for_ingest" || state.outcome === "reconciling") { await acceptedUpload(await awaitAcceptance(opened)); return; }
  if (state.outcome !== "uploading") throw new Error("Narriflow is reconciling this upload. Retry with the same selected file shortly.");
  const transfer = record(state.transfer);
  const parts = Array.isArray(transfer.completedParts) ? transfer.completedParts as Array<{ partNumber: number; etag: string }> : [];
  let completed = 0;
  progress.hidden = false;
  progress.max = source.size;
  if (transfer.kind === "single") {
    const grant = record(transfer.grant);
    await put(text(grant.url), source, text(grant.contentType));
    progress.value = source.size;
  } else {
    const partSize = Number(transfer.partSizeBytes);
    const count = Number(transfer.partCount);
    if (!Number.isSafeInteger(partSize) || partSize < 1 || !Number.isSafeInteger(count) || count < 1 || count > 10_000) throw new Error("Invalid upload transfer plan");
    const grants = new Map((Array.isArray(transfer.grants) ? transfer.grants as Array<{ partNumber: number; url: string }> : []).map((entry) => [entry.partNumber, entry.url]));
    const done = new Set(parts.map((entry) => entry.partNumber));
    for (const entry of parts) completed += Math.min(partSize, source.size - (entry.partNumber - 1) * partSize);
    for (let number = 1; number <= count; number++) {
      if (done.has(number)) continue;
      let url = grants.get(number);
      if (!url) {
        const result = await call("narriflow_upload_grants", { workspaceId: context.workspaceId, sessionId, partNumbers: [number] });
        const data = record(result._meta?.uploadTransfer);
        const refreshed = Array.isArray(data.grants) ? data.grants as Array<{ partNumber: number; url: string }> : [];
        url = refreshed.find((entry) => entry.partNumber === number)?.url;
      }
      if (!url) throw new Error("Upload authorization could not be renewed");
      const bytes = source.slice((number - 1) * partSize, Math.min(number * partSize, source.size));
      const etag = await put(url, bytes);
      if (!etag) throw new Error("Storage did not return an ETag. Open Narriflow to finish uploading.");
      parts.push({ partNumber: number, etag });
      completed += bytes.size;
      progress.value = completed;
      status.textContent = `Uploading ${Math.round(completed / source.size * 100)}%`;
    }
  }
  const finished = await call("narriflow_upload_finalize", { workspaceId: context.workspaceId, sessionId, parts: parts.sort((a, b) => a.partNumber - b.partNumber) });
  status.textContent = "Narriflow is verifying your upload…";
  await acceptedUpload(await awaitAcceptance(finished));
}
async function put(url: string, bytes: Blob, contentType?: string) {
  const response = await fetch(url, { method: "PUT", body: bytes, headers: contentType ? { "Content-Type": contentType } : undefined, credentials: "omit", redirect: "error" });
  if (!response.ok) throw new Error("Upload interrupted. Retry with the same file to resume.");
  return response.headers.get("etag");
}

app.ontoolinput = ({ arguments: input }) => { arguments_ = record(input); };
app.ontoolresult = (result) => { try { render(result); } catch (error) { status.textContent = error instanceof Error ? error.message : "Unable to display this result"; } };
app.ontoolcancelled = () => { status.textContent = "Request cancelled"; action.disabled = true; };

action.addEventListener("click", async () => {
  if (busy || view === "publication-confirmation" && !publicationDecision.canConfirm) return;
  busy = true; action.disabled = true; secondary.disabled = true;
  try {
    if (view === "upload") await upload();
    else if (view === "progress") {
      const request = narriflowProgressRequest(payload, arguments_, metadata);
      render(await call(request.name, request.arguments));
    }
    else if (view === "publication-confirmation") {
      await publicationDecision.decide(true, async (markSchedulingAttempted) => {
        const intent = record(payload.intent);
        const token = metadata.confirmationToken ?? payload.preparationToken;
        if (!publicationReceipt) {
          const decision = await call("narriflow_accept_social_post_intent", { workspaceId: intent.workspaceId ?? arguments_.workspaceId, token, accepted: true });
          publicationReceipt = decision._meta?.confirmationReceipt;
        }
        markSchedulingAttempted();
        render(await call("narriflow_schedule_social_post", { workspaceId: intent.workspaceId ?? arguments_.workspaceId, clientIdempotencyKey: intent.clientIdempotencyKey, preparationToken: token, confirmationReceipt: publicationReceipt }));
      });
    }
    else await openLink();
  } catch (error) { status.textContent = error instanceof Error ? error.message : "This action could not be completed"; }
  finally { busy = false; action.disabled = false; secondary.disabled = false; renderPublicationDecision(); }
});
secondary.addEventListener("click", async () => {
  if (view === "publication-confirmation") {
    if (busy || !publicationDecision.canDecline) return;
    busy = true; renderPublicationDecision();
    try {
      await publicationDecision.decide(false, async () => {
        const intent = record(payload.intent);
        const result = await app.callServerTool({ name: "narriflow_accept_social_post_intent", arguments: { workspaceId: intent.workspaceId ?? arguments_.workspaceId, token: metadata.confirmationToken ?? payload.preparationToken, accepted: false } });
        if (result.isError && !isPublicationDeclined(result)) throw new Error("Unable to record the decision. No post was scheduled.");
      });
    } catch (error) { status.textContent = error instanceof Error ? error.message : "Unable to record the decision. No post was scheduled."; }
    finally { busy = false; renderPublicationDecision(); }
  } else await openLink();
});

await app.connect();
