type Facts = Record<string, unknown>;
export function record(value: unknown): Facts {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Facts : {};
}
export function text(value: unknown) {
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}
export function escapeHtml(value: unknown) {
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
const icon = (path: string, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const uploadIcon = icon('<path d="M12 16V4m0 0L7 9m5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>', 26);
const checkIcon = icon('<path d="m5 12.5 4.5 4.5L19 7.5"/>', 16);
const downloadIcon = icon('<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M4 20h16"/>', 16);
const arrowIcon = icon('<path d="M7 17 17 7M9 7h8v8"/>', 15);

export interface CardView { title: string; badge: string; html: string; tone?: "live" | "done" | "failed"; }
export interface ExportChoice { aspectRatio: string; resolution: string; }
const ASPECT_RATIOS = ["9:16", "1:1", "16:9", "4:5"];
const RESOLUTIONS = ["720p", "1080p"];
const RING_LENGTH = 213.6;

function score(value: unknown) { return Math.round(Math.min(100, Math.max(0, number(value)))); }
function segmented(name: string, label_: string, options: string[], selected: string) {
  return `<div class="segmented" role="group" aria-label="${escapeHtml(label_)}">${options.map((option) =>
    `<button type="button" data-segment="${escapeHtml(name)}" data-value="${escapeHtml(option)}" aria-pressed="${option === selected}">${escapeHtml(option)}</button>`).join("")}</div>`;
}
function scoreBar(name: string, value: number, index: number) {
  return `<div class="score-row"><span>${name}</span><div class="track" role="meter" aria-label="${name}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><i data-strength="${value >= 80 ? "high" : "low"}" style="--value:${value}%;--delay:${index * 60}ms"></i></div><strong>${value}</strong></div>`;
}

const logo = (background: string, mark: string) => `<svg class="logo" viewBox="0 0 24 24" aria-hidden="true"><rect width="24" height="24" rx="7" fill="${background}"/>${mark}</svg>`;
const platformLogos: Record<string, string> = {
  tiktok: logo("#000", '<path fill="#fff" d="M13.4 5h2.2c.2 1.6 1.2 2.8 3 3v2.2c-1.1 0-2.1-.3-3-.9v4.8a4.5 4.5 0 1 1-3.9-4.5v2.3a2.2 2.2 0 1 0 1.7 2.2z"/>'),
  youtube: logo("#f00", '<path fill="#fff" d="M9.6 8.2v7.6l6.4-3.8z"/>'),
  instagram: logo("#d6249f", '<rect x="6" y="6" width="12" height="12" rx="3.6" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="12" cy="12" r="2.8" fill="none" stroke="#fff" stroke-width="1.6"/><circle cx="15.6" cy="8.4" r=".9" fill="#fff"/>'),
  facebook: logo("#1877f2", '<path fill="#fff" d="M13.2 19v-6.2h2.1l.3-2.4h-2.4V8.9c0-.7.2-1.2 1.2-1.2h1.3V5.5c-.2 0-1-.1-1.9-.1-1.9 0-3.1 1.1-3.1 3.2v1.8H8.6v2.4h2.1V19z"/>'),
  linkedin: logo("#0a66c2", '<path fill="#fff" d="M7 10h2.4v7.5H7zM8.2 6.5a1.4 1.4 0 1 1 0 2.8 1.4 1.4 0 0 1 0-2.8m2.9 3.5h2.3v1c.3-.6 1.1-1.2 2.3-1.2 2.4 0 2.8 1.6 2.8 3.6v4.1h-2.4v-3.7c0-.9 0-2-1.2-2s-1.4 1-1.4 1.9v3.8h-2.4z"/>'),
  x: logo("#000", '<path fill="#fff" d="m13.2 11 4.5-5.2h-1.1l-3.9 4.5-3.1-4.5H6l4.7 6.9L6 18.2h1.1l4.1-4.8 3.3 4.8H18zm-1.5 1.7-.5-.7L7.5 6.6h1.6l3.1 4.4.5.7 4 5.7h-1.6z"/>'),
};
function platformLogo(value: unknown) {
  const key = text(value).replace(/_(?:shorts|reels)$/, "");
  return platformLogos[key] ?? "";
}
function verdict(value: number) {
  return value >= 85 ? "Outstanding" : value >= 70 ? "Strong" : value >= 50 ? "Promising" : "Needs work";
}
const RATIO_ICON = 24;
function ratioTiles(selected: string) {
  return `<div class="ratios" role="group" aria-label="Format">${ASPECT_RATIOS.map((ratio) => {
    const [width, height] = ratio.split(":").map(Number) as [number, number];
    const scale = RATIO_ICON / Math.max(width, height);
    return `<button type="button" data-segment="aspectRatio" data-value="${ratio}" aria-pressed="${ratio === selected}"><i style="width:${Math.round(width * scale)}px;height:${Math.round(height * scale)}px"></i><span>${ratio}</span></button>`;
  }).join("")}</div>`;
}

export function clipView(payload: Facts, choice: ExportChoice = { aspectRatio: "9:16", resolution: "1080p" }): CardView {
  const clip = record(payload.clip);
  const scores = record(clip.scores);
  const virality = score(scores.virality);
  const metrics: Array<[string, string]> = [["hookStrength", "Hook"], ["pacing", "Pacing"], ["storyCompleteness", "Story"], ["emotionalIntensity", "Emotion"], ["durationOptimality", "Length"]];
  const tabs = [clip.reasoning ? ["why", "Why it works", `<p>${escapeHtml(clip.reasoning)}</p>`] : null,
    clip.transcriptExcerpt ? ["transcript", "Transcript", `<p>${escapeHtml(clip.transcriptExcerpt)}</p>`] : null].filter((tab): tab is string[] => Boolean(tab));
  const platforms = Array.isArray(clip.platformFit) ? clip.platformFit.map((value) => `<span class="platform" title="${escapeHtml(label(value))}">${platformLogo(value) || escapeHtml(label(value))}</span>`).join("") : "";
  return {
    title: text(clip.title) || "Review your clip", badge: label(clip.status) || "Clip review",
    html: `<div class="meta"><span>${clock(clip.startSec)}–${clock(clip.endSec)} in source</span>${clip.category ? `<span>${escapeHtml(label(clip.category))}</span>` : ""}${platforms ? `<span class="platforms" aria-label="Best on ${escapeHtml(Array.isArray(clip.platformFit) ? clip.platformFit.map(label).join(", ") : "")}">${platforms}</span>` : ""}</div>
      <div class="review"><section aria-label="Clip preview"><div id="preview" class="media"><span>Preview available in Narriflow</span></div></section>
      <section class="scores" aria-label="Clip scores">
        <div class="ring-row"><div class="ring" role="img" aria-label="Virality ${virality} out of 100"><svg viewBox="0 0 80 80" aria-hidden="true"><circle cx="40" cy="40" r="34"/><circle class="ring-value" cx="40" cy="40" r="34" style="--ring-empty:${RING_LENGTH};--ring-full:${RING_LENGTH * (1 - virality / 100)}"/></svg><strong>${virality}</strong></div><div><h2>${verdict(virality)}</h2><p class="subtle">Virality score</p></div></div>
        <div class="bars">${metrics.map(([key, name], index) => scoreBar(name, score(scores[key]), index)).join("")}</div>
      </section></div>
      ${clip.hookText ? `<blockquote class="hook">${escapeHtml(clip.hookText)}</blockquote>` : ""}
      ${tabs.length ? `<section class="tabs"><div class="tablist" role="tablist">${tabs.map(([id, name], index) => `<button type="button" role="tab" data-tab="${id}" aria-selected="${index === 0}">${name}</button>`).join("")}<button type="button" class="text-link tab-link" id="open-result">Open in Studio</button></div>${tabs.map(([id, , html], index) => `<div class="tabpanel" role="tabpanel" data-panel="${id}"${index === 0 ? "" : " hidden"}>${html}</div>`).join("")}</section>` : '<button type="button" class="text-link" id="open-result">Open in Studio</button>'}
      <section class="dock" aria-label="Export this clip">${ratioTiles(choice.aspectRatio)}${segmented("resolution", "Quality", RESOLUTIONS, choice.resolution)}<div class="dock-action" data-dock></div></section>`,
  };
}
export function uploadView(payload: Facts, context: Facts): CardView {
  const generation = record(record(context.generationContext).contentPack);
  if (payload.outcome === "queued_for_ingest") return {
    title: "Your video is on its way", badge: "Upload received", tone: "done",
    html: `<div class="hero"><div class="hero-copy"><span class="done-mark">${checkIcon}</span><h2>Upload received</h2><p>Narriflow is processing your video. Open your project to follow progress and review your clips.</p></div>${heroArt}</div>`,
  };
  return {
    title: "Turn a video into clips", badge: "Upload video",
    html: `<label class="dropzone" id="file-picker"><span class="drop-icon">${uploadIcon}</span><strong id="file-name">Choose a file or drop it here</strong><span id="file-description">Video or audio from your device</span><span class="picker-button" aria-hidden="true">Browse files</span><input id="file" type="file" accept="video/*,audio/*" aria-label="Choose a video or audio file">${heroArt}</label>
      <dl class="facts" aria-label="Generation settings">${context.recipeId ? fact("Settings", "Your saved Recipe") : `${fact("Output", generation.defaultAspectRatio ?? "9:16")}${fact("Clip length", label(generation.clipLengthPreset ?? "auto"))}${fact("Captions", label(generation.captionPreset ?? "brand_default"))}`}</dl>
      <p class="subtle">One credit per started minute of video.</p>`,
  };
}
const heroArt = '<span class="hero-art" aria-hidden="true"><i></i><i></i><i></i></span>';

const GENERATION_STEPS = ["Import", "Transcribe", "Find moments", "Render"];
const EXPORT_STEPS = ["Queued", "Rendering", "Ready"];
function steps(names: string[], current: number, finished: boolean) {
  return `<ol class="steps">${names.map((name, index) => {
    const state = finished || index < current ? "done" : index === current ? "current" : "todo";
    return `<li data-state="${state}"${state === "current" ? ' aria-current="step"' : ""}><span class="step-dot">${state === "done" ? checkIcon : ""}</span>${escapeHtml(name)}</li>`;
  }).join("")}</ol>`;
}
function generationStep(stage: string) {
  if (/render|prepar|finish/.test(stage)) return 3;
  if (/detect|moment|select/.test(stage)) return 2;
  if (/transcri|stt/.test(stage)) return 1;
  return 0;
}
function friendlyStage(stage: string) {
  return stage === "detecting" ? "Finding your best moments" : stage === "transcribing" ? "Transcribing" : stage === "rendering" ? "Rendering" : label(stage);
}
function liveCard(input: { heading: string; percent: number | null; finished: boolean; failed: boolean; steps: string; note: string }) {
  const value = input.finished ? 100 : input.percent;
  return `<section class="live" data-tone="${input.failed ? "failed" : input.finished ? "done" : "live"}"><div class="live-head"><h2>${escapeHtml(input.heading)}</h2><strong>${input.failed ? "Stopped" : input.finished ? "Complete" : value === null ? "Working" : `${value}%`}</strong></div>
    <div class="bar"${value === null ? ' data-indeterminate="true"' : ""}><i data-percent="${value ?? 0}"></i></div>${input.steps}
    <p class="subtle">${escapeHtml(input.note)}</p></section>`;
}
function exportOutcome(outcome: Facts) {
  const variants = Array.isArray(outcome.variants) ? outcome.variants.map(record) : [];
  if (!variants.length) return "";
  const first = variants[0]!;
  return `<div class="result reveal"><div class="player" id="result-video" style="--ratio:${escapeHtml(text(first.aspectRatio).replace(":", "/"))}"></div>
    <ul class="files">${variants.map((variant, index) => `<li><div><strong>${escapeHtml(variant.aspectRatio)} · ${escapeHtml(variant.resolution)}</strong><span>${typeof variant.sizeBytes === "number" ? fileSize(variant.sizeBytes) : "MP4"}${variant.watermark ? " · Watermark" : ""}</span></div>${variants.length > 1 ? `<button type="button" class="soft" data-download="${index}">${downloadIcon}Download</button>` : ""}</li>`).join("")}</ul></div>`;
}
function clipsOutcome(outcome: Facts) {
  const clips = Array.isArray(outcome.items) ? outcome.items.map(record) : [];
  if (!clips.length) return "";
  return `<ol class="clips reveal">${clips.map((clip, index) => {
    const virality = score(record(clip.scores).virality);
    return `<li><button type="button" data-open-clip="${index}" style="--index:${index}"><span class="rank">${index + 1}</span><span class="clip-copy"><strong>${escapeHtml(clip.title)}</strong><span>${clock(clip.durationSec)}${clip.category ? ` · ${escapeHtml(label(clip.category))}` : ""}</span></span><span class="clip-score" aria-label="Virality ${virality}">${virality}</span>${arrowIcon}</button></li>`;
  }).join("")}</ol>`;
}
export function progressView(payload: Facts, outcome: Facts = {}): CardView {
  if (typeof payload.state === "string") return operationView(payload, outcome);
  const exported = record(payload.export);
  const project = record(payload.project);
  const progress = record(payload.progress);
  const isExport = Boolean(payload.export);
  const state = text(exported.status ?? progress.status ?? payload.status);
  const ready = state === "ready" || state === "completed";
  const failed = state === "failed";
  const percentValue = exported.progress ?? progress.percent;
  const percent = typeof percentValue === "number" ? Math.round(Math.min(100, Math.max(0, percentValue))) : null;
  const variants = Array.isArray(exported.variants) ? exported.variants.map(record) : [];
  const output = record(payload.output);
  const limited = output.reason === "plan_limit" ? `<p class="notice">Your plan delivers ${escapeHtml(record(output.granted).resolution)}${record(output.granted).watermark ? " with a watermark" : ""}. Upgrade in Narriflow for more.</p>` : "";
  const note = failed ? "Open Narriflow to inspect the failure and retry."
    : ready ? (isExport ? "Open Narriflow to preview and download your export." : "Open your project to review the clips.")
    : isExport && state === "queued" ? "It starts as soon as a render slot opens." : "This updates live while Narriflow works.";
  return {
    title: isExport ? (failed ? "This export needs attention" : ready ? "Your export is ready" : "Preparing your export") : text(project.title) || "Creating your clips",
    badge: label(state) || "Processing", tone: failed ? "failed" : ready ? "done" : "live",
    html: exportOutcome(outcome) || `${liveCard({ heading: isExport ? "Clip export" : text(progress.label) || "Video processing", percent, finished: ready, failed,
      steps: isExport ? steps(EXPORT_STEPS, state === "queued" ? 0 : 1, ready) : "", note })}
      ${isExport ? `<dl class="facts">${fact("Quality", exported.resolution)}${fact("Version", number(exported.editorRevision))}${fact("Format", variants.map((variant) => variant.aspectRatio).join(", "))}</dl>` : payload.project ? `<dl class="facts">${fact("Status", label(state))}</dl>` : ""}
      ${limited}${exported.isOlderVersion ? '<p class="notice">This export uses an earlier edit. Open Narriflow to review the current version.</p>' : ""}`,
  };
}
/** Operation Status: the exact work one request started. */
function operationView(payload: Facts, outcome: Facts): CardView {
  const reference = record(payload.operation);
  const isExport = reference.kind === "export";
  const state = text(payload.state);
  const done = state === "completed";
  const stopped = state === "failed" || state === "cancelled";
  const percent = typeof payload.progress === "number" ? Math.round(Math.min(1, Math.max(0, payload.progress)) * 100) : null;
  const items = Array.isArray(payload.items) ? payload.items.map(record) : [];
  const finished = items.filter((item) => item.state === "completed").length;
  const noun = isExport ? "formats" : "clips";
  const stage = text(payload.stage);
  const note = state === "failed" ? "Open Narriflow to inspect the failure and retry."
    : state === "partial" ? `${finished} of ${items.length} ${noun} finished. Open Narriflow to review the rest.`
    : state === "cancelled" ? "This work was cancelled."
    : done ? (isExport ? "Your files are ready below." : "Pick a clip to review it in the Studio.")
    : isExport && !percent ? "It starts as soon as a render slot opens." : "This updates live while Narriflow works.";
  // Once the work exists, it is the card: the path there no longer matters.
  const result = isExport ? exportOutcome(outcome) : clipsOutcome(outcome);
  return {
    title: state === "cancelled" ? "This work was cancelled" : state === "failed" ? (isExport ? "This export needs attention" : "These clips need attention")
      : isExport ? (done ? "Your export is ready" : "Preparing your export") : done ? "Your clips are ready" : "Creating your clips",
    badge: state === "working" && isExport && !percent ? "Queued" : label(state) || "Processing", tone: stopped ? "failed" : done || state === "partial" ? "done" : "live",
    html: result && done ? result : `${liveCard({ heading: isExport ? "Clip export" : friendlyStage(stage) || "Video processing", percent, finished: done, failed: stopped,
      steps: isExport ? steps(EXPORT_STEPS, percent ? 1 : 0, done) : steps(GENERATION_STEPS, generationStep(stage), done), note })}
      ${result}`,
  };
}
export function confirmationView(payload: Facts, locale?: string): CardView {
  const intent = record(payload.intent);
  if (!payload.intent) return payload.status === "scheduled"
    ? { title: "Your post is scheduled", badge: "Scheduled", tone: "done", html: `<div class="hero"><div class="hero-copy"><span class="done-mark">${checkIcon}</span><h2>Post scheduled</h2><p>Open Narriflow to follow its publication status.</p><button type="button" class="text-link" id="open-result">Open publication</button></div>${heroArt}</div>` }
    : { title: "Publication details unavailable", badge: "Review required", html: '<p class="intro">Open Narriflow to inspect this post before scheduling.</p>' };
  const when = new Date(text(intent.scheduledFor));
  const validDate = Number.isFinite(when.getTime());
  const scheduled = validDate ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(when) : "Time unavailable";
  const zone = validDate ? new Intl.DateTimeFormat(locale, { timeZoneName: "short" }).formatToParts(when).find((part) => part.type === "timeZoneName")?.value : "";
  const settings = Object.entries(record(intent.providerSettings)).map(([key, value]) => fact(label(key), typeof value === "boolean" ? value ? "On" : "Off" : value ?? "Default")).join("");
  const month = validDate ? new Intl.DateTimeFormat(locale, { month: "short" }).format(when) : "";
  const day = validDate ? new Intl.DateTimeFormat(locale, { day: "numeric" }).format(when) : "";
  // Every fact of the approval stays on the card, never behind a disclosure.
  return {
    title: "Review before scheduling", badge: "Confirmation required",
    html: `<div class="post"><div class="phone" id="post-preview" style="--ratio:${escapeHtml(text(intent.aspectRatio).replace(":", "/") || "9/16")}"><span class="phone-mark" aria-hidden="true"></span></div>
      <div class="post-body">
        <div class="destination">${platformLogo(intent.platform)}<div><strong>${escapeHtml(payload.accountDisplayName)}</strong><span>${escapeHtml(label(intent.platform))}</span></div></div>
        <section class="caption" aria-label="Caption"><p>${escapeHtml(intent.caption) || '<span class="subtle">No caption</span>'}</p></section>
        <div class="when">${validDate ? `<div class="calendar" aria-hidden="true"><span>${escapeHtml(month)}</span><strong>${escapeHtml(day)}</strong></div>` : ""}<div class="fact"><dt>Publish at</dt><dd>${escapeHtml(`${scheduled}${zone ? ` ${zone}` : ""}`)}</dd></div></div>
        <dl class="facts">${fact("Reviewed output", `${text(intent.aspectRatio)} / ${text(intent.resolution)} / Version ${number(intent.expectedEditorRevision)}`)}${fact("Delivery", intent.deliveryMode === "inbox" ? "Send to inbox" : "Direct publication")}</dl>
        <button type="button" class="text-link" id="review-export">Open the selected export</button>
        ${settings ? `<details class="more"><summary>Publishing settings</summary><dl class="facts">${settings}</dl></details>` : ""}
      </div></div>`,
  };
}
