/**
 * Shared product facts for the /lp/* landing variants.
 * Sourced from packages/validators (caption presets), billing.service.ts
 * (tiers) and the worker pipeline — keep in sync with those, not with vibes.
 */

export const VARIANTS = [
  { key: "blueprint", label: "Blueprint", href: "/lp/blueprint" },
  { key: "studio", label: "Studio", href: "/lp/studio" },
  { key: "signal", label: "Signal", href: "/lp/signal" },
  { key: "atelier", label: "Atelier", href: "/lp/atelier" },
  { key: "system", label: "System", href: "/lp/system" },
  { key: "pop", label: "Pop", href: "/lp/pop" },
  { key: "volt", label: "Volt", href: "/lp/volt" },
] as const;

/** Verified pain points from the product research (Notion, Feb 2026). */
export const PAIN_POINTS = [
  { quote: "I spend 4 hours editing one episode.", fix: "Full pipeline in about 10 minutes." },
  { quote: "My clips miss the best moments.", fix: "Every moment scored 0–100 before you render." },
  { quote: "I need content for 5 platforms.", fix: "One click exports every aspect ratio." },
  { quote: "Credits and pricing are confusing.", fix: "One metric: a minute in is a minute metered." },
  { quote: "My workflows randomly break.", fix: "One pipeline, watched end to end." },
  { quote: "Support never responds.", fix: "A human answers within a day." },
] as const;

/** Competitor comparison (research pack, Feb 2026) — for comparison sections. */
export const COMPARISON = {
  columns: ["Narriflow", "OpusClip", "Vizard", "Repurpose.io"],
  rows: [
    { label: "Starting price", values: ["$7/mo", "$15/mo", "$29/mo", "$35/mo"] },
    { label: "Pricing metric", values: ["Plain minutes", "Credits", "Credits", "Video count"] },
    { label: "Virality scoring", values: ["0–100, every moment", "Basic", "—", "—"] },
    { label: "Written formats", values: ["5 formats", "—", "—", "—"] },
    { label: "AI dubbing", values: ["Included on Pro", "Subtitles only", "Subtitles only", "—"] },
    { label: "RSS autopilot", values: ["Included", "—", "—", "Rule engine"] },
  ],
} as const;

export const PIPELINE = [
  {
    n: "01",
    key: "ingest",
    title: "Ingest",
    body: "Upload a recording or paste a YouTube link. Audio extracted, media probed, ready in minutes.",
    meta: "mp4 · mov · youtube · rss",
  },
  {
    n: "02",
    key: "stt",
    title: "Transcribe",
    body: "Word-level speech-to-text builds the timing backbone every caption and cut relies on.",
    meta: "word-accurate timestamps",
  },
  {
    n: "03",
    key: "moments",
    title: "Detect moments",
    body: "AI reads the whole transcript, finds the clip-worthy moments, and scores each one for virality.",
    meta: "scored 0–100",
  },
  {
    n: "04",
    key: "render",
    title: "Render clips",
    body: "Captions burned in exactly as previewed — every aspect ratio, auto-reframed around the speaker.",
    meta: "9:16 · 1:1 · 16:9 · 4:5",
  },
  {
    n: "05",
    key: "publish",
    title: "Publish",
    body: "Schedule straight to TikTok, Shorts, Reels, LinkedIn and X from the same workflow.",
    meta: "5 platforms",
  },
] as const;

export const FEATURES = [
  {
    key: "moments",
    title: "AI moment detection",
    body: "Every moment scored for virality, so you render the winners — not the whole hour.",
  },
  {
    key: "captions",
    title: "Word-synced captions",
    body: "12 presets, 9 animation styles, emoji captions. The preview is the export.",
  },
  {
    key: "ratios",
    title: "Every aspect ratio",
    body: "9:16, 1:1, 16:9 and 4:5 from one render pass — each platform gets its native frame.",
  },
  {
    key: "reframe",
    title: "Auto-reframe + B-roll",
    body: "Speaker-tracked crops keep faces centered; stock B-roll drops in where it helps.",
  },
  {
    key: "repurpose",
    title: "Content-suite repurposing",
    body: "Blog post, X thread, LinkedIn post, show notes and quote cards from the same transcript.",
  },
  {
    key: "publish",
    title: "Direct publishing",
    body: "Connect accounts once, then schedule and post clips without leaving Narriflow.",
  },
  {
    key: "dubbing",
    title: "AI dubbing",
    body: "Re-voice clips into new languages with synced audio — one recording, every market.",
  },
  {
    key: "autopilot",
    title: "RSS autopilot",
    body: "Point it at a podcast feed and new episodes become scored clips while you sleep.",
  },
] as const;

export const CAPTION_PRESETS = [
  { name: "Karaoke", accent: "#00FF88" },
  { name: "Highlighter", accent: "#FFE94A" },
  { name: "Fire", accent: "#FF6A2B" },
  { name: "Neon Dreams", accent: "#B26BFF" },
  { name: "Electric", accent: "#4AD7FF" },
  { name: "Street", accent: "#FFFFFF" },
  { name: "Luxe Gold", accent: "#E8C15A" },
  { name: "Matrix", accent: "#3CFF6E" },
  { name: "Minimal", accent: "#E9EBEE" },
  { name: "Sunset", accent: "#FF8A5C" },
  { name: "Pastel Cloud", accent: "#AFC8FF" },
  { name: "Frosted Glass", accent: "#DDE7F5" },
] as const;

export const PLATFORMS = ["TikTok", "YouTube Shorts", "Instagram Reels", "LinkedIn", "X"] as const;

export const REPURPOSE_FORMATS = [
  { name: "Blog post", detail: "SEO-aware Markdown, 600–1000 words" },
  { name: "X thread", detail: "6–10 numbered tweets with a CTA" },
  { name: "LinkedIn post", detail: "150–300 words, engagement-ready" },
  { name: "Show notes", detail: "Summary, timestamps, key takeaways" },
  { name: "Quote cards", detail: "3–5 verbatim pull-quotes" },
] as const;

export const TIERS = [
  {
    name: "Free",
    price: 0,
    minutes: 60,
    blurb: "Test the whole workflow",
    points: ["60 processing min/mo", "720p renders", "Uploads up to 30 min"],
    featured: false,
  },
  {
    name: "Starter",
    price: 7,
    minutes: 300,
    blurb: "No watermark, your brand",
    points: ["300 processing min/mo", "1080p, no watermark", "Brand templates"],
    featured: false,
  },
  {
    name: "Creator",
    price: 12,
    minutes: 600,
    blurb: "Clips plus every written format",
    points: ["600 processing min/mo", "Content-suite repurposing", "Uploads up to 90 min"],
    featured: true,
  },
  {
    name: "Pro",
    price: 24,
    minutes: 1800,
    blurb: "Every language, every format",
    points: ["1,800 processing min/mo", "AI voiceover dubbing", "Uploads up to 3 hours"],
    featured: false,
  },
] as const;

export const STATS = [
  { value: 12, suffix: "", label: "caption presets" },
  { value: 4, suffix: "", label: "aspect ratios per render" },
  { value: 5, suffix: "", label: "platforms published to" },
  { value: 1800, suffix: "", label: "processing min on Pro" },
] as const;
