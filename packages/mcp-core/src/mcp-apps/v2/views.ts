type Facts = Record<string, unknown>;
export function record(value: unknown): Facts {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Facts : {};
}
export function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
function escapeHtml(value: unknown) {
  return text(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
function number(value: unknown) { return typeof value === "number" && Number.isFinite(value) ? value : 0; }
export function clock(value: unknown) {
  const seconds = Math.max(0, Math.floor(number(value)));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
export function fileSize(bytes: number) {
  return bytes >= 1_000_000_000 ? `${(bytes / 1_000_000_000).toFixed(1)} GB` : bytes >= 1_000_000 ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1_000)} KB`;
}
const names: Record<string, string> = {
  tiktok: "TikTok", youtube_shorts: "YouTube Shorts", youtube: "YouTube", instagram_reels: "Instagram Reels", instagram: "Instagram", facebook_reels: "Facebook Reels", facebook: "Facebook", linkedin: "LinkedIn", x: "X",
  ready: "Ready", queued: "Queued", pending: "Queued", processing: "Processing", rendering: "Rendering", completed: "Complete", failed: "Needs attention", detected: "Ready to review", edited: "Edited", accepted: "Queued", working: "Processing", cancelled: "Cancelled",
  controversy: "Controversy", insight: "Insight", hook: "Hook", story: "Story", humor: "Humor", emotional: "Emotional", tutorial: "Tutorial", quote: "Quote", debate: "Debate", surprise: "Surprise",
  auto: "Automatic length", under_30s: "Under 30 seconds", "30_to_60s": "30–60 seconds", "60_to_120s": "60–120 seconds", "120_to_180s": "120–180 seconds", brand_default: "Brand captions", minimal: "Minimal captions", caption_only: "Caption video", clip: "Generate clips",
};
function label(value: unknown) {
  const key = text(value);
  if (names[key]) return names[key];
  const words = key.replace(/([a-z])([A-Z])/g, "$1 $2").replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
function fact(name: string, value: unknown) {
  return `<div class="fact"><dt>${escapeHtml(name)}</dt><dd>${escapeHtml(value)}</dd></div>`;
}
function chips(values: unknown) {
  return Array.isArray(values) ? values.map((value) => `<span class="chip">${escapeHtml(label(value))}</span>`).join("") : "";
}
const uploadIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 16V4m0 0L7 9m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';
export interface CardView { title: string; badge: string; html: string; }
export function clipView(payload: Facts): CardView {
  const clip = record(payload.clip);
  const scores = record(clip.scores);
  const metrics = [["virality", "Virality"], ["hookStrength", "Hook strength"], ["pacing", "Pacing"], ["storyCompleteness", "Story"], ["emotionalIntensity", "Emotion"], ["durationOptimality", "Length"]];
  const scoreRows = metrics.map(([key, name]) => {
    const value = Math.min(100, Math.max(0, number(scores[key!])));
    return `<div class="score-row"><span>${name}</span><meter min="0" max="100" value="${value}" aria-label="${name}">${value} out of 100</meter><strong>${value}</strong></div>`;
  }).join("");
  return {
    title: text(clip.title) || "Review your clip", badge: label(clip.status) || "Clip review",
    html: `<div class="clip-meta"><span>${Math.round(number(clip.durationSec))} seconds</span><span>${clock(clip.startSec)}–${clock(clip.endSec)} in source</span><span>Version ${number(clip.editorRevision)}</span></div>
      <div class="review-layout"><section class="review-main" aria-label="Clip preview"><div id="preview" class="media-well"><span>Preview available in Narriflow</span></div>
      ${clip.hookText ? `<p class="hook">${escapeHtml(clip.hookText)}</p>` : ""}<div class="chips">${chips(clip.platformFit)}</div></section>
      <section class="scores" aria-label="Clip scores"><div class="score-heading"><h2>Clip scores</h2><span>Out of 100</span></div>${scoreRows}</section></div>
      ${clip.reasoning || clip.transcriptExcerpt ? `<details class="insight"><summary>Why this clip works${clip.category ? `<span class="chip">${escapeHtml(label(clip.category))}</span>` : ""}</summary>${clip.reasoning ? `<p>${escapeHtml(clip.reasoning)}</p>` : ""}${clip.transcriptExcerpt ? `<h3>Transcript excerpt</h3><p>${escapeHtml(clip.transcriptExcerpt)}</p>` : ""}</details>` : ""}`,
  };
}
export function uploadView(payload: Facts, context: Facts): CardView {
  const generation = record(record(context.generationContext).contentPack);
  const accepted = payload.outcome === "queued_for_ingest";
  const title = accepted ? "Your video is on its way" : "Turn a video into clips";
  return {
    title, badge: accepted ? "Upload received" : "Upload video",
    html: accepted ? '<div class="upload-success"><span class="success-mark" aria-hidden="true">✓</span><h2>Upload received</h2><p>Narriflow is processing your video. Open your project to follow progress and review your clips.</p></div>' :
      `<p class="intro">Choose a video or audio file. Narriflow will find the moments worth sharing.</p>
      <label class="file-picker" id="file-picker">${uploadIcon}<strong id="file-name">Choose a file or drop it here</strong><span id="file-description">Video or audio from your device</span><span class="picker-button" aria-hidden="true">Browse files</span><input id="file" type="file" accept="video/*,audio/*" aria-label="Choose a video or audio file"></label>
      <dl class="settings-band" aria-label="Generation settings">${fact("Output", generation.defaultAspectRatio ?? "9:16")}${fact("Clip length", label(generation.clipLengthPreset ?? "auto"))}${fact("Captions", label(generation.captionPreset ?? "brand_default"))}</dl>
      <p class="subtle">Your file uploads directly to Narriflow. Processing uses your workspace's minute quota.</p>`,
  };
}
export function progressView(payload: Facts): CardView {
  const exported = record(payload.export);
  const project = record(payload.project);
  const progress = record(payload.progress);
  const isExport = Boolean(payload.export);
  const state = text(exported.status ?? progress.status ?? payload.status);
  const ready = state === "ready" || state === "completed";
  const percentValue = exported.progress ?? progress.percent;
  const percent = typeof percentValue === "number" ? Math.min(100, Math.max(0, percentValue)) : null;
  const variants = Array.isArray(exported.variants) ? exported.variants.map(record) : [];
  return {
    title: isExport ? (ready ? "Your export is ready" : "Preparing your export") : text(project.title) || "Creating your clips",
    badge: label(state) || "Processing",
    html: `<section class="operation"><div class="operation-heading"><h2>${escapeHtml(isExport ? "Clip export" : progress.label ?? "Video processing")}</h2><strong>${ready ? "Complete" : percent === null ? "In progress" : `${Math.round(percent)}%`}</strong></div>
      <progress class="operation-progress" max="100" ${percent === null && !ready ? "" : `value="${ready ? 100 : percent}"`} aria-label="${isExport ? "Export" : "Project"} progress"></progress>
      <p class="subtle">${state === "failed" ? "Open Narriflow to inspect the failure and retry." : ready ? (isExport ? "Open Narriflow to preview and download your export." : "Open your project to review the clips and choose what to export.") : "You can check back here while Narriflow works."}</p></section>
      ${isExport || payload.project ? `<dl class="settings-band">${isExport ? fact("Quality", exported.resolution) + fact("Version", number(exported.editorRevision)) + fact("Format", variants.map((variant) => text(variant.aspectRatio)).join(", ")) : fact("Source", label(project.sourceType)) + fact("Duration", typeof project.durationSeconds === "number" ? clock(project.durationSeconds) : "Not available yet") + fact("Language", text(project.languageCode)?.toUpperCase() || "Automatic")}</dl>` : ""}
      ${exported.isOlderVersion ? '<p class="notice">This export uses an earlier edit. Open Narriflow to review the current version.</p>' : ""}`,
  };
}
export function confirmationView(payload: Facts, locale?: string): CardView {
  const intent = record(payload.intent);
  if (!payload.intent) return payload.status === "scheduled" ? { title: "Your post is scheduled", badge: "Scheduled", html: '<div class="upload-success"><span class="success-mark" aria-hidden="true">✓</span><h2>Post scheduled</h2><p>Open Narriflow to follow its publication status.</p><button class="text-link" id="open-result">Open publication</button></div>' } : { title: "Publication details unavailable", badge: "Review required", html: '<p class="intro">Open Narriflow to inspect this post before scheduling.</p>' };
  const when = new Date(text(intent.scheduledFor));
  const validDate = Number.isFinite(when.getTime());
  const scheduled = validDate ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(when) : "Time unavailable";
  const zone = validDate ? new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(when).find((part) => part.type === "timeZoneName")?.value : "";
  const settings = Object.entries(record(intent.providerSettings)).map(([key, value]) => fact(label(key), typeof value === "boolean" ? value ? "On" : "Off" : value ?? "Default")).join("");
  return {
    title: "Review before scheduling", badge: "Confirmation required",
    html: `<p class="intro">Confirm this post exactly as shown. It will be scheduled only after your approval.</p>
      <dl class="confirmation-facts">${fact("Destination", payload.accountDisplayName)}${fact("Platform", label(intent.platform))}${fact("Publish at", `${scheduled}${zone ? ` ${zone}` : ""}`)}${fact("Reviewed output", `${text(intent.aspectRatio)} / ${text(intent.resolution)} / Version ${number(intent.expectedEditorRevision)}`)}${fact("Delivery", intent.deliveryMode === "inbox" ? "Send to inbox" : "Direct publication")}</dl>
      <button class="text-link" id="review-export">Preview the selected export</button>
      <section class="caption-preview"><h2>Caption</h2><p>${escapeHtml(intent.caption) || '<span class="subtle">No caption</span>'}</p></section>
      ${settings ? `<details class="insight"><summary>Publishing settings</summary><dl class="confirmation-facts">${settings}</dl></details>` : ""}`,
  };
}
