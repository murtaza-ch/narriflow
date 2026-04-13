# Interactive Caption Editor — Implementation Plan

## Context & Motivation

**Problem**: The studio editor at `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/` currently runs entirely on mock/hardcoded data. There is no real video playback, no real transcript data, and no caption editing capability. Captions are burned into the video only during FFmpeg rendering in the worker — the user cannot preview or edit them before rendering.

**Goal**: Build an Opus Clip-like interactive caption editor where:
- Source video plays in the browser with captions overlaid as HTML/CSS elements
- Captions show real-time word-by-word highlighting synced to video playback
- Transcript text is editable in the left panel
- Caption styling changes (font, color, position, etc.) preview instantly on the video
- Text is only "burned" into the video during final export/render
- The user has full editing flexibility before committing to a render

**Reference**: The experience at `clip.opus.pro/editor-ux/` — left transcript panel, center video preview with HTML caption overlay, right tool sidebar with caption styling, bottom timeline.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Server Component (page.tsx)                │
│  - requireCurrentAppUser()                                   │
│  - clipService.listClips() → clip w/ transcriptSlice + words │
│  - presignDownloadUrl(sourceStorageKey) → video URL (1hr TTL)│
└──────────────────────┬──────────────────────────────────────┘
                       │ props
                       ▼
┌─────────────────────────────────────────────────────────────┐
│              StudioShell (Client Context Provider)            │
│  State: transcript (editable), captionPreset, currentTime,   │
│         isPlaying, aspectRatio, segments, saveState, ...     │
│  videoRef → <video src={presignedUrl}>                       │
│  Auto-save: debounced PATCH on transcript/preset changes     │
├──────────┬──────────────────────┬────────────────────────────┤
│ Transcript│    VideoPreview      │      ToolSidebar           │
│ Panel     │  ┌────────────────┐ │  ┌──────────────────────┐  │
│ (editable │  │ <video> element │ │  │ CaptionsPanel        │  │
│  content- │  │ + CaptionOverlay│ │  │ (font, color, pos,   │  │
│  Editable │  │ (HTML/CSS words)│ │  │  outline, shadow,    │  │
│  per      │  └────────────────┘ │  │  highlight, animation)│  │
│  utterance│                     │  └──────────────────────┘  │
│  )        │                     │                            │
├───────────┴─────────────────────┴────────────────────────────┤
│                        Timeline                               │
│  (segments from utterances, playhead, split, zoom)            │
└──────────────────────────────────────────────────────────────┘
```

---

## Current Codebase State (What Exists Today)

### Studio UI Components (all use mock data)

| Component | File | Current State |
|-----------|------|---------------|
| StudioShell | `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx` | Context provider with 16+ state variables. Uses mock data. Has simulated playback timer (no real video). |
| VideoPreview | `apps/web/.../studio/_components/video-preview.tsx` | Shows placeholder gradient. Has `<video>` element with `display: "none"`. Has mock `CaptionOverlay` with hardcoded `CAPTION_WORDS` array that cycles based on `currentTime * 2`. |
| TranscriptPanel | `apps/web/.../studio/_components/transcript-panel.tsx` | Read-only transcript display. Shows speech blocks + b-roll descriptions. Has word highlighting and click-to-seek. NOT editable. |
| CaptionsPanel | `apps/web/.../studio/_components/tool-panels/captions-panel.tsx` | Style editor for font, color, outline, shadow, position, animation. Updates `captionPreset` in context. Already functional for styling. |
| Timeline | `apps/web/.../studio/_components/timeline.tsx` | Segments with playhead, split, delete, zoom. Uses mock segments. |
| TopBar | `apps/web/.../studio/_components/top-bar.tsx` | Back button, title, undo/redo, save button (mock save), export dropdown, credits. |
| ToolSidebar | `apps/web/.../studio/_components/tool-sidebar.tsx` | 9 tool buttons with sliding panels. |
| page.tsx | `apps/web/.../studio/page.tsx` | Passes `MOCK_CLIP_INFO`, `MOCK_TRANSCRIPT`, `MOCK_TIMELINE_SEGMENTS`, `MOCK_CAPTION_PRESET` to StudioShell. |

### Key Types in StudioShell (`studio-shell.tsx`)

```typescript
// These types are defined in studio-shell.tsx (lines 21-74)
export type AspectRatio = "9:16" | "1:1" | "16:9" | "4:5";
export type LayoutMode = "fill" | "fit" | "blur";
export type CaptionAnimation = "none" | "word-by-word" | "karaoke" | "bounce";
export type ToolId = "ai-enhance" | "captions" | "upload" | "brand" | "broll" | "transitions" | "text" | "music" | "ai-hook";

export interface CaptionPreset {
  fontName: string;
  primaryColor: string;
  outlineColor: string;
  outlineWidth: number;
  shadow: number;
  bold: boolean;
  position: "top" | "center" | "bottom";
  highlightColor?: string;
  animation?: CaptionAnimation;
}

export interface TranscriptItem {
  id: string;
  type: "speech" | "broll";
  text?: string;
  timestamp: number;
  highlights?: { word: string; color: "green" | "amber" | "orange" }[];
  description?: string;
}

export interface TimelineSegment {
  id: string;
  label: string;
  startSec: number;
  endSec: number;
}

export interface ClipInfo {
  id: string;
  projectId: string;
  title: string;
  duration: number;
  startSec: number;
  endSec: number;
  aspectRatio: AspectRatio;
  viralityScore: number;
  category: string;
  credits: number;
}
```

### Mock CaptionOverlay in VideoPreview (`video-preview.tsx` lines 20-82)

```typescript
// This is what needs to be replaced with real word-timing-based overlay
const CAPTION_WORDS = [
  { words: ["AND", "THEN"], active: 0 },
  { words: ["DURING", "THE"], active: 1 },
  // ... 10 hardcoded word groups
];

function CaptionOverlay({ currentTime, preset }) {
  const idx = Math.floor(currentTime * 2) % CAPTION_WORDS.length;
  const group = CAPTION_WORDS[idx];
  // Renders words with active word highlighted
}
```

### Backend Data Model

**Clip model** (Prisma schema at `packages/db/prisma/schema.prisma` lines 367-403):
```
model Clip {
  id              String       @id @default(uuid()) @db.Uuid
  projectId       String       @db.Uuid
  startSec        Float        // Clip start time in source video
  endSec          Float        // Clip end time in source video
  transcriptSlice Json         // TranscriptUtterance[] array
  captionPreset   Json?        // CaptionPreset object (nullable)
  status          ClipStatus   @default(detected)
  // ... other fields (scores, category, etc.)
  renders         ClipRender[]
}
```

**TranscriptUtterance schema** (`packages/validators/src/transcript.ts` lines 12-20):
```typescript
export const transcriptUtteranceSchema = z.object({
  index: z.number().int().nonnegative(),
  speaker: z.number().int().nonnegative().nullable(),
  speakerLabel: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
});
// NOTE: No word-level timing exists yet — only utterance-level
```

**CaptionPreset schema** (`packages/validators/src/clip.ts` lines 117-125):
```typescript
export const captionPresetSchema = z.object({
  fontName: z.string().max(100).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  outlineColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  outlineWidth: z.number().int().min(0).max(4).optional(),
  shadow: z.number().int().min(0).max(1).optional(),
  bold: z.boolean().optional(),
  position: z.enum(["bottom", "top"]).optional(),
  // MISSING: highlightColor, animation, "center" position
});
```

**Deepgram transcription** (`apps/worker/src/tasks/transcribe.ts`):
- Uses Deepgram Nova-3 API with `utterances=true`
- `normalizeDeepgramTranscript()` in `packages/services/src/transcript.service.ts` converts response
- The `DeepgramWord` interface (line 8) only has `word` and `punctuated_word` — it does NOT capture `start`, `end`, `confidence` even though Deepgram returns them
- Raw Deepgram JSON IS saved to R2 storage for reference
- The normalizer DISCARDS word-level timing, keeping only utterance-level data

**Worker rendering** (`apps/worker/src/tasks/render-clips.ts`):
- `generateSrtFromSlice()` (line 214): Converts `TranscriptUtterance[]` to SRT with utterance-level cues
- `buildSubtitleFilter()` (line 243): Creates FFmpeg `subtitles` filter with ASS force_style from `CaptionPreset`
- Uses `hexToFfmpegColor()` to convert hex colors to FFmpeg ASS BGRA format
- Caption styles vary by aspect ratio: font size and margin adjustments per ratio
- Supports: `fontName`, `primaryColor`, `outlineColor`, `outlineWidth`, `shadow`, `bold`, `position` (top=8, bottom=2)

**API routes** (`apps/web/app/api/[[...route]]/route.ts`):
- `PATCH /api/projects/:id/clips/:clipId` supports three update shapes:
  1. Status update: `{ status: "accepted" | "rejected" }`
  2. Boundary update: `{ startSec, endSec }`
  3. Caption preset update: `{ captionPreset: CaptionPreset | null }`
- No transcript editing endpoint exists

---

## Phase 1: Word-Level Timing in Data Layer

### Why First
Deepgram already provides word-level timing (`words[].start, .end, .word, .punctuated_word, .confidence`) in each utterance's response. The current `normalizeDeepgramTranscript()` discards this data. Without per-word timestamps, word-by-word caption highlighting in the browser is impossible. This is a backend-only change with zero UI coupling.

### Step 1.1: Add `TranscriptWord` schema to validators

**File**: `packages/validators/src/transcript.ts`

**What to do**:
1. Add a new Zod schema `transcriptWordSchema` BEFORE `transcriptUtteranceSchema`:
```typescript
export const transcriptWordSchema = z.object({
  word: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  confidence: z.number().min(0).max(1).nullable().optional(),
});

export type TranscriptWord = z.infer<typeof transcriptWordSchema>;
```

2. Add an optional `words` field to `transcriptUtteranceSchema`:
```typescript
export const transcriptUtteranceSchema = z.object({
  index: z.number().int().nonnegative(),
  speaker: z.number().int().nonnegative().nullable(),
  speakerLabel: z.string().min(1),
  startSec: z.number().nonnegative(),
  endSec: z.number().nonnegative(),
  text: z.string().min(1),
  confidence: z.number().min(0).max(1).nullable(),
  words: z.array(transcriptWordSchema).optional(), // NEW
});
```

3. Export the `TranscriptWord` type alongside the existing exports.

**Why optional**: Backward-compatible — existing data in the DB has no `words` field. The Zod schema won't reject existing data.

### Step 1.2: Capture word data in Deepgram normalizer

**File**: `packages/services/src/transcript.service.ts`

**What to do**:

1. Extend the `DeepgramWord` interface (line 8) to include timing fields:
```typescript
interface DeepgramWord {
  word?: string;
  punctuated_word?: string;
  start?: number;  // ADD
  end?: number;    // ADD
  confidence?: number; // ADD
}
```

2. In `normalizeDeepgramTranscript()` (line 114), inside the `.map()` at line 128, add `words` to the returned utterance object. Currently the return at line 139 is:
```typescript
return {
  index,
  speaker: ...,
  speakerLabel: ...,
  startSec,
  endSec: ...,
  text,
  confidence: ...,
} satisfies TranscriptUtterance;
```

Change to:
```typescript
return {
  index,
  speaker: ...,
  speakerLabel: ...,
  startSec,
  endSec: ...,
  text,
  confidence: ...,
  words: (utterance.words ?? [])
    .filter((w) => (w.word || w.punctuated_word) && typeof w.start === "number" && typeof w.end === "number")
    .map((w) => ({
      word: w.punctuated_word ?? w.word ?? "",
      startSec: w.start!,
      endSec: w.end!,
      confidence: typeof w.confidence === "number" ? w.confidence : null,
    })),
} satisfies TranscriptUtterance;
```

3. Update the import at the top of the file to include `TranscriptWord` if needed for type checking.

**No backfill needed**: This is a fresh/dev environment. New transcriptions will automatically include word timing.

### Step 1.3: Update transcript service tests

**File**: `packages/services/src/transcript.service.test.ts`

Update existing test fixtures to include `words` in the Deepgram payload, and add a test case that verifies word-level timing is captured correctly:

```typescript
it("captures word-level timing from Deepgram utterances", () => {
  const payload = {
    results: {
      utterances: [{
        start: 1.0,
        end: 3.5,
        transcript: "hello world",
        confidence: 0.95,
        speaker: 0,
        words: [
          { word: "hello", punctuated_word: "Hello", start: 1.0, end: 1.8, confidence: 0.97 },
          { word: "world", punctuated_word: "world", start: 2.0, end: 3.5, confidence: 0.93 },
        ],
      }],
      channels: [{ alternatives: [{ transcript: "hello world" }] }],
    },
    metadata: { duration: 5.0 },
  };

  const result = normalizeDeepgramTranscript(payload);
  expect(result.utterances[0].words).toHaveLength(2);
  expect(result.utterances[0].words![0]).toEqual({
    word: "Hello",
    startSec: 1.0,
    endSec: 1.8,
    confidence: 0.97,
  });
});
```

---

## Phase 2: Extend `captionPreset` Schema

### Why
The DB `captionPresetSchema` is missing fields the studio UI already uses: `highlightColor` (for word-by-word color), `animation` (caption animation mode), and `"center"` as a position option. These must be in the DB schema so they persist across sessions and are available to the worker.

### Step 2.1: Extend `captionPresetSchema` in validators

**File**: `packages/validators/src/clip.ts`

**What to do**: Replace the existing `captionPresetSchema` (lines 117-125) with:

```typescript
export const captionPresetSchema = z.object({
  fontName: z.string().max(100).optional(),
  primaryColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  outlineColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(),
  outlineWidth: z.number().int().min(0).max(4).optional(),
  shadow: z.number().int().min(0).max(1).optional(),
  bold: z.boolean().optional(),
  position: z.enum(["bottom", "top", "center"]).optional(),        // CHANGED: added "center"
  highlightColor: z.string().regex(/^#[0-9A-Fa-f]{6}$/).optional(), // NEW
  animation: z.enum(["none", "word-by-word", "karaoke", "bounce"]).optional(), // NEW
});
```

All new fields are optional, so existing DB records with `captionPreset` will still parse correctly.

### Step 2.2: Update worker for `center` position

**File**: `apps/worker/src/tasks/render-clips.ts`

**What to do**: In `buildSubtitleFilter()` at line 265, the alignment mapping currently is:
```typescript
const alignment = captionPreset?.position === "top" ? 8 : 2;
```

Change to:
```typescript
const alignment = captionPreset?.position === "top" ? 8 : captionPreset?.position === "center" ? 5 : 2;
```

**ASS Alignment values**: 2 = bottom-center, 5 = middle-center, 8 = top-center.

**Note on `highlightColor` and `animation`**: These are **preview-only** for the initial implementation. The worker will not use them when burning captions. The burned render uses uniform `primaryColor` for all words. This matches how Opus Clip and CapCut work — the preview is richer than the export. Phase 6 addresses improving the worker output.

---

## Phase 3: Real Video Playback & Server Data Loading

### Why
This is the highest-impact change. The studio goes from a "mock demo" to a "real editor" with actual video playback and real transcript data.

### Step 3.1: Load real data in `page.tsx` (server component)

**File**: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/page.tsx`

**What to do**: Replace the entire file. Remove all mock data constants and fetch real data instead.

**Pattern to follow**: Look at the existing project detail page at `apps/web/app/(app)/projects/[projectId]/page.tsx` — it demonstrates the exact pattern for authenticated data loading with `requireCurrentAppUser()`, service calls, and presigned URLs.

**Implementation**:

```typescript
import { notFound } from "next/navigation";
import { requireCurrentAppUser } from "@/lib/auth"; // or wherever this is
import { clipService, projectService, presignDownloadUrl } from "@narriflow/services";
import type { TranscriptUtterance } from "@narriflow/validators";
import { StudioShell } from "./_components/studio-shell";
import type { TimelineSegment, ClipInfo, CaptionPreset } from "./_components/studio-shell";

const DEFAULT_CAPTION_PRESET: CaptionPreset = {
  fontName: "Bebas Neue",
  primaryColor: "#FFFFFF",
  outlineColor: "#000000",
  outlineWidth: 2,
  shadow: 1,
  bold: true,
  position: "bottom",
  highlightColor: "#00ff88",
  animation: "word-by-word",
};

function buildSegmentsFromUtterances(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
): TimelineSegment[] {
  return utterances.map((u, i) => ({
    id: `seg-${i}`,
    label: "Fill",
    startSec: u.startSec - clipStartSec,
    endSec: u.endSec - clipStartSec,
  }));
}

export default async function StudioPage({
  params,
}: {
  params: Promise<{ projectId: string; clipId: string }>;
}) {
  const appUser = await requireCurrentAppUser();
  const { projectId, clipId } = await params;

  // 1. Fetch clip data
  const clips = await clipService.listClips(appUser.id, projectId);
  const clip = clips.find((c) => c.id === clipId);
  if (!clip) notFound();

  // 2. Get project for source video URL
  const snapshot = await projectService.getProjectSnapshot(appUser.id, projectId);
  if (!snapshot.project) notFound();

  // 3. Generate presigned URL for source video
  let sourceVideoUrl: string | null = null;
  if (snapshot.project.sourceStorageKey) {
    sourceVideoUrl = await presignDownloadUrl({
      key: snapshot.project.sourceStorageKey,
      expiresIn: 3600, // 1 hour
    });
  }

  // 4. Parse transcript data
  const utterances = (clip.transcriptSlice ?? []) as TranscriptUtterance[];

  // 5. Parse or default caption preset
  const captionPreset: CaptionPreset = clip.captionPreset
    ? { ...DEFAULT_CAPTION_PRESET, ...(clip.captionPreset as Partial<CaptionPreset>) }
    : DEFAULT_CAPTION_PRESET;

  // 6. Build clip info
  const clipInfo: ClipInfo = {
    id: clip.id,
    projectId: clip.projectId,
    title: snapshot.project.title ?? "Untitled Clip",
    duration: clip.endSec - clip.startSec,
    startSec: clip.startSec,
    endSec: clip.endSec,
    aspectRatio: "9:16", // default, can be derived from renders
    viralityScore: clip.viralityScore,
    category: clip.category,
    credits: 10, // TODO: get from user/project
  };

  return (
    <StudioShell
      clipInfo={clipInfo}
      transcript={utterances}
      timelineSegments={buildSegmentsFromUtterances(utterances, clip.startSec)}
      initialCaptionPreset={captionPreset}
      sourceVideoUrl={sourceVideoUrl}
      clipStartSec={clip.startSec}
      clipEndSec={clip.endSec}
    />
  );
}
```

**Important**: You'll need to verify the exact import paths for `requireCurrentAppUser`, `clipService`, `projectService`, and `presignDownloadUrl` by checking how the existing project detail page imports them. Use `Grep` to find these imports.

### Step 3.2: Add new props to StudioShell

**File**: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx`

**What to do**:

1. Add new props to `StudioShellProps` (line 134):
```typescript
interface StudioShellProps {
  clipInfo: ClipInfo;
  transcript: TranscriptUtterance[];  // CHANGED from TranscriptItem[] to real type
  timelineSegments: TimelineSegment[];
  initialCaptionPreset: CaptionPreset;
  sourceVideoUrl?: string | null;  // NEW
  clipStartSec?: number;           // NEW
  clipEndSec?: number;             // NEW
}
```

2. Add these to the context interface `StudioContextValue` (line 98):
```typescript
interface StudioContextValue extends StudioState {
  // ... existing fields ...
  sourceVideoUrl: string | null;
  clipStartSec: number;
  clipEndSec: number;
  utterances: TranscriptUtterance[];  // NEW: real utterances with words
  // ... existing methods ...
}
```

3. Store them in the component and pass through context:
```typescript
export function StudioShell({
  clipInfo, transcript, timelineSegments, initialCaptionPreset,
  sourceVideoUrl = null, clipStartSec = 0, clipEndSec = 0,
}: StudioShellProps) {
  // Store utterances as mutable state (for Phase 5 editing)
  const [utterances, setUtterances] = useState<TranscriptUtterance[]>(
    Array.isArray(transcript) ? transcript : []
  );
  // ... rest of state ...
```

4. **Replace the simulated playback timer** (lines 312-325). Currently:
```typescript
// Simulate time advancing when playing (no real video)
useEffect(() => {
  if (!isPlaying) return;
  const interval = setInterval(() => {
    setCurrentTime((t) => {
      if (t >= duration) { setIsPlaying(false); return 0; }
      return t + 0.1;
    });
  }, 100);
  return () => clearInterval(interval);
}, [isPlaying, duration]);
```

Replace with real video time sync:
```typescript
// Sync currentTime from video element
useEffect(() => {
  const video = videoRef.current;
  if (!video || !sourceVideoUrl) {
    // Fallback: simulate time for demo mode (no video)
    if (!isPlaying) return;
    const interval = setInterval(() => {
      setCurrentTime((t) => {
        if (t >= duration) { setIsPlaying(false); return 0; }
        return t + 0.1;
      });
    }, 100);
    return () => clearInterval(interval);
  }

  const handleTimeUpdate = () => {
    const clipRelativeTime = video.currentTime - clipStartSec;
    setCurrentTime(Math.max(0, clipRelativeTime));

    // Stop at clip end
    if (video.currentTime >= clipEndSec) {
      video.pause();
      setIsPlaying(false);
    }
  };

  video.addEventListener("timeupdate", handleTimeUpdate);
  return () => video.removeEventListener("timeupdate", handleTimeUpdate);
}, [sourceVideoUrl, clipStartSec, clipEndSec, isPlaying, duration]);
```

5. **Update `seekTo`** (line 184) to translate clip-relative time to absolute video time:
```typescript
const seekTo = useCallback((t: number) => {
  const clamped = Math.max(0, Math.min(duration, t));
  setCurrentTime(clamped);
  if (videoRef.current && sourceVideoUrl) {
    videoRef.current.currentTime = clipStartSec + clamped;
  }
}, [duration, clipStartSec, sourceVideoUrl]);
```

6. **Update `togglePlay`** (line 168) to seek to start if at end:
```typescript
const togglePlay = useCallback(() => {
  const video = videoRef.current;
  if (!video || !sourceVideoUrl) {
    setIsPlaying((v) => !v);
    return;
  }
  if (video.currentTime >= clipEndSec || video.currentTime < clipStartSec) {
    video.currentTime = clipStartSec;
    setCurrentTime(0);
  }
  if (video.paused) {
    video.play().catch(() => {});
    setIsPlaying(true);
  } else {
    video.pause();
    setIsPlaying(false);
  }
}, [sourceVideoUrl, clipStartSec, clipEndSec]);
```

### Step 3.3: Wire up `<video>` element in VideoPreview

**File**: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/video-preview.tsx`

**What to do**:

1. Get `sourceVideoUrl` and `clipStartSec` from context:
```typescript
const {
  aspectRatio, setAspectRatio,
  layoutMode, setLayoutMode,
  trackerEnabled, setTrackerEnabled,
  currentTime, captionPreset,
  selectedSegmentId,
  videoRef,
  sourceVideoUrl,  // NEW
  clipStartSec,    // NEW
} = useStudio();
```

2. Add a state to track whether the video has loaded:
```typescript
const [videoLoaded, setVideoLoaded] = useState(false);
```

3. Add an effect to set the video source and handle loading:
```typescript
useEffect(() => {
  const video = videoRef.current;
  if (!video || !sourceVideoUrl) return;

  video.src = sourceVideoUrl;

  const handleLoaded = () => {
    video.currentTime = clipStartSec;
    setVideoLoaded(true);
  };

  video.addEventListener("loadedmetadata", handleLoaded);
  return () => video.removeEventListener("loadedmetadata", handleLoaded);
}, [sourceVideoUrl, clipStartSec, videoRef]);
```

4. Update the `<video>` element (line 390) — show it when loaded:
```typescript
<video
  ref={videoRef}
  style={{
    position: "absolute",
    inset: 0,
    width: "100%",
    height: "100%",
    objectFit: layoutMode === "fit" ? "contain" : "cover",
    display: videoLoaded ? "block" : "none", // CHANGED: show when loaded
  }}
  playsInline
  preload="auto"
/>
```

5. Conditionally hide the placeholder gradient when video is loaded:
```typescript
{/* Placeholder gradient when no video */}
{!videoLoaded && (
  <Box position="absolute" inset="0" background="linear-gradient(...)">
    {/* ... placeholder content ... */}
  </Box>
)}
```

### Time Coordinate System

**Critical design decision**: All studio UI uses **clip-relative time** (0 to `duration` where `duration = endSec - startSec`).

- `currentTime` in context = clip-relative (0 to duration)
- `video.currentTime` = absolute project time (clipStartSec to clipEndSec)
- Translation: `clipRelative = video.currentTime - clipStartSec`
- Translation: `video.currentTime = clipStartSec + clipRelative`
- Timeline segments use clip-relative time
- Transcript utterance timestamps are ABSOLUTE (from original video), so when displaying/matching, convert: `absoluteTime = currentTime + clipStartSec`

---

## Phase 4: Real-Time Word-Synced Caption Overlay

### Why
This is the core visual feature — replacing hardcoded mock captions with real word-by-word highlighting synced to video playback.

### Step 4.1: Create `useCurrentCaption` hook

**New file**: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/use-current-caption.ts`

```typescript
"use client";

import { useMemo } from "react";
import type { TranscriptUtterance, TranscriptWord } from "@narriflow/validators";

interface CaptionState {
  /** The utterance that contains the current playback time */
  currentUtterance: TranscriptUtterance | null;
  /** Index of the active word within the utterance */
  activeWordIndex: number;
  /** The words to display (2-4 word window for word-by-word mode) */
  visibleWords: { word: string; isActive: boolean }[];
}

/**
 * Given the current playback time and transcript utterances,
 * determines which utterance and word is currently active.
 *
 * @param currentTime - Clip-relative time (0 to duration)
 * @param utterances - TranscriptUtterance[] with optional words[]
 * @param clipStartSec - Absolute start time of the clip in the source
 */
export function useCurrentCaption(
  currentTime: number,
  utterances: TranscriptUtterance[],
  clipStartSec: number,
): CaptionState {
  return useMemo(() => {
    const absoluteTime = currentTime + clipStartSec;

    // Find active utterance
    const utterance = utterances.find(
      (u) => absoluteTime >= u.startSec && absoluteTime < u.endSec,
    );

    if (!utterance) {
      return { currentUtterance: null, activeWordIndex: -1, visibleWords: [] };
    }

    const words = utterance.words;

    // Fallback: no word-level timing available
    if (!words || words.length === 0) {
      // Show all words from utterance text, no active highlighting
      const textWords = utterance.text.split(/\s+/).filter(Boolean);
      return {
        currentUtterance: utterance,
        activeWordIndex: -1,
        visibleWords: textWords.map((w) => ({ word: w, isActive: false })),
      };
    }

    // Find active word by timestamp
    let activeWordIndex = words.findIndex(
      (w) => absoluteTime >= w.startSec && absoluteTime < w.endSec,
    );

    // If between words, find the closest upcoming word
    if (activeWordIndex === -1) {
      activeWordIndex = words.findIndex((w) => w.startSec > absoluteTime) - 1;
      if (activeWordIndex < 0) activeWordIndex = 0;
    }

    // Word-by-word mode: show a sliding window of 2-4 words
    const WINDOW_SIZE = 3; // Number of words to show at once
    const halfWindow = Math.floor(WINDOW_SIZE / 2);

    let windowStart = Math.max(0, activeWordIndex - halfWindow);
    let windowEnd = Math.min(words.length, windowStart + WINDOW_SIZE);

    // Adjust window if at boundaries
    if (windowEnd - windowStart < WINDOW_SIZE && windowEnd === words.length) {
      windowStart = Math.max(0, windowEnd - WINDOW_SIZE);
    }

    const visibleWords = words.slice(windowStart, windowEnd).map((w, i) => ({
      word: w.word,
      isActive: windowStart + i === activeWordIndex,
    }));

    return { currentUtterance: utterance, activeWordIndex, visibleWords };
  }, [currentTime, utterances, clipStartSec]);
}
```

### Step 4.2: Replace mock `CaptionOverlay` in VideoPreview

**File**: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/video-preview.tsx`

**What to do**:

1. Remove the hardcoded `CAPTION_WORDS` constant (lines 20-31) entirely.

2. Remove the entire mock `CaptionOverlay` function (lines 33-82).

3. Add import for the hook:
```typescript
import { useCurrentCaption } from "./use-current-caption";
```

4. Create the new `CaptionOverlay` component:

```typescript
function CaptionOverlay() {
  const { currentTime, captionPreset, utterances, clipStartSec } = useStudio();
  const { visibleWords } = useCurrentCaption(currentTime, utterances, clipStartSec);

  if (visibleWords.length === 0) return null;

  const preset = captionPreset;
  const highlight = preset.highlightColor ?? "#00ff88";

  // Position styles
  const positionStyle: React.CSSProperties =
    preset.position === "top"
      ? { top: "10%" }
      : preset.position === "center"
        ? { top: "50%", transform: "translateY(-50%)" }
        : { bottom: "12%" };

  // Text shadow for outline effect
  const outlineWidth = preset.outlineWidth ?? 2;
  const outlineColor = preset.outlineColor ?? "#000000";
  const shadowParts: string[] = [];

  // Outline via text-shadow (4-directional + diagonals)
  if (outlineWidth > 0) {
    for (let x = -outlineWidth; x <= outlineWidth; x++) {
      for (let y = -outlineWidth; y <= outlineWidth; y++) {
        if (x === 0 && y === 0) continue;
        shadowParts.push(`${x}px ${y}px 0 ${outlineColor}`);
      }
    }
  }

  // Drop shadow
  if (preset.shadow) {
    shadowParts.push(`0 2px 8px rgba(0,0,0,0.9)`);
  }

  return (
    <Box
      position="absolute"
      left="0"
      right="0"
      display="flex"
      justifyContent="center"
      px="8%"
      pointerEvents="none"
      style={positionStyle}
    >
      <Flex gap="6px" align="center" flexWrap="wrap" justify="center">
        {visibleWords.map((item, i) => (
          <Text
            key={`${item.word}-${i}`}
            fontSize="clamp(20px, 5vw, 36px)"
            fontWeight={preset.bold ? "900" : "600"}
            letterSpacing="0.04em"
            color={item.isActive ? highlight : preset.primaryColor}
            style={{
              fontFamily: `"${preset.fontName}", Impact, sans-serif`,
              textShadow: shadowParts.join(", ") || undefined,
              transition: "color 80ms ease-out",
              textTransform: "uppercase",
            }}
          >
            {item.word}
          </Text>
        ))}
      </Flex>
    </Box>
  );
}
```

5. Update the usage in the `VideoPreview` component (line 413). Currently:
```typescript
<CaptionOverlay currentTime={currentTime} preset={captionPreset} />
```

Change to (no props needed, reads from context):
```typescript
<CaptionOverlay />
```

### Step 4.3: Graceful fallback

The `useCurrentCaption` hook already handles the case where `utterance.words` is undefined or empty — it falls back to splitting `utterance.text` by whitespace and showing all words with `isActive: false` (no highlighting). This ensures clips without word timing still show captions.

---

## Phase 5: Editable Transcript Panel

### Why
Users need to correct transcription errors, remove filler words, and adjust text before rendering. This is a core part of the Opus Clip workflow.

### Step 5.1: Move transcript to mutable context state

**File**: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx`

**What to do**:

1. The `transcript` prop is currently stored as a read-only reference in context (line 99, 331). It's already stored as an array. We need to:
   - Keep `utterances` as `useState` (already done in Step 3.2 above)
   - Add `setUtterances` to context
   - Add `updateUtteranceText(utteranceIndex: number, newText: string)` helper function

2. Add the `updateUtteranceText` function that handles word timing recalculation:

```typescript
const updateUtteranceText = useCallback((utteranceIndex: number, newText: string) => {
  setUtterances((prev) => {
    const updated = [...prev];
    const utterance = updated[utteranceIndex];
    if (!utterance) return prev;

    const oldWords = utterance.words ?? [];
    const newWordTexts = newText.trim().split(/\s+/).filter(Boolean);

    if (newWordTexts.length === 0) return prev;

    // Proportional redistribution of timing
    const utteranceDuration = utterance.endSec - utterance.startSec;
    const wordDuration = utteranceDuration / newWordTexts.length;

    const newWords = newWordTexts.map((word, i) => ({
      word,
      startSec: utterance.startSec + i * wordDuration,
      endSec: utterance.startSec + (i + 1) * wordDuration,
      confidence: null,
    }));

    updated[utteranceIndex] = {
      ...utterance,
      text: newText.trim(),
      words: newWords,
    };

    return updated;
  });
}, []);
```

3. Add `utterances`, `setUtterances`, and `updateUtteranceText` to the context value object.

4. **Retire the `TranscriptItem` type**: The `TranscriptItem` interface (lines 47-54 in studio-shell.tsx) was for mock data. The real data uses `TranscriptUtterance` from `@narriflow/validators`. The `TranscriptPanel` component needs to be updated to work with `TranscriptUtterance` instead of `TranscriptItem`. The key differences:
   - `TranscriptItem` has `type: "speech" | "broll"` — real utterances are all "speech"
   - `TranscriptItem` has `highlights` — not in real data (this was mock UI decoration)
   - `TranscriptItem` has `description` for b-roll — not applicable to real data
   - `TranscriptUtterance` has `speakerLabel`, `speaker`, `index`, `words`, `confidence`

### Step 5.2: Make transcript blocks editable

**File**: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/transcript-panel.tsx`

**What to do**:

1. Update the component to read `utterances` (not `transcript`) from context:
```typescript
const { utterances, updateUtteranceText, currentTime, seekTo, clipStartSec } = useStudio();
```

2. Replace the read-only speech blocks with editable ones. For each utterance, render a `contentEditable` div:

```typescript
function EditableUtterance({
  utterance,
  index,
  isActive,
  onTextChange,
  onWordClick,
}: {
  utterance: TranscriptUtterance;
  index: number;
  isActive: boolean;
  onTextChange: (index: number, newText: string) => void;
  onWordClick: (startSec: number) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [isEditing, setIsEditing] = useState(false);

  const handleBlur = useCallback(() => {
    setIsEditing(false);
    const text = ref.current?.textContent?.trim();
    if (text && text !== utterance.text) {
      onTextChange(index, text);
    }
  }, [index, utterance.text, onTextChange]);

  const handleFocus = useCallback(() => {
    setIsEditing(true);
  }, []);

  // When NOT editing, render individual word spans for click-to-seek
  // When editing, render plain contentEditable text
  return (
    <Box
      ref={ref}
      contentEditable
      suppressContentEditableWarning
      onBlur={handleBlur}
      onFocus={handleFocus}
      outline="none"
      cursor="text"
      px="4px"
      py="2px"
      borderRadius="4px"
      bg={isActive ? "rgba(99,102,241,0.08)" : "transparent"}
      _hover={{ bg: "rgba(255,255,255,0.04)" }}
      _focus={{ bg: "rgba(99,102,241,0.12)", boxShadow: "0 0 0 1px rgba(99,102,241,0.3)" }}
      fontSize="14px"
      lineHeight="1.7"
      color="#e0e0e0"
      transition="background 150ms"
    >
      {utterance.text}
    </Box>
  );
}
```

3. **Click-to-seek on words**: When not in editing mode, each word can be a clickable span that calls `seekTo(word.startSec - clipStartSec)`. When the utterance is focused for editing, word spans become plain text. This requires rendering differently based on `isEditing` state.

4. **Active utterance highlighting**: Determine which utterance is active based on `currentTime + clipStartSec` falling within its `[startSec, endSec]` range. Highlight it with a subtle background color.

5. **Auto-scroll**: Keep the auto-scroll behavior — scroll the active utterance into view when playback progresses. The existing transcript panel has this pattern with `data-timestamp` attributes.

### Step 5.3: Add transcript update API endpoint

**File**: `apps/web/app/api/[[...route]]/route.ts`

**What to do**:

1. Add a new validation schema for transcript updates. Import `transcriptUtteranceSchema` from `@narriflow/validators`:

```typescript
const updateClipTranscriptSchema = z.object({
  transcriptSlice: z.array(transcriptUtteranceSchema),
});
```

2. In the `PATCH /api/projects/:id/clips/:clipId` handler (line 434), add a fourth shape check. The current handler uses `safeParse` to check which shape the body matches. Add after the existing checks:

```typescript
// Shape 4: Transcript update
const transcriptUpdate = updateClipTranscriptSchema.safeParse(body);
if (transcriptUpdate.success) {
  await clipService.updateClipTranscriptSlice(
    appUser.id,
    projectId,
    clipId,
    transcriptUpdate.data.transcriptSlice,
  );
  // Return updated clip
  const updatedClip = await clipService.getClip(appUser.id, projectId, clipId);
  return c.json({ clip: updatedClip });
}
```

3. **Add service method** in `packages/services/src/clip.service.ts`:

```typescript
async updateClipTranscriptSlice(
  userId: string,
  projectId: string,
  clipId: string,
  transcriptSlice: TranscriptUtterance[],
) {
  // Validate project ownership (reuse existing pattern from updateClipStatus)
  const project = await this.findProjectForUser(userId, projectId);
  if (!project) throw new Error("Project not found");

  await prisma.clip.update({
    where: { id: clipId, projectId },
    data: {
      transcriptSlice: transcriptSlice as unknown as Prisma.InputJsonValue,
      status: "edited",
    },
  });
}
```

### Step 5.4: Debounced auto-save

**File**: `apps/web/app/(app)/projects/[projectId]/clips/[clipId]/studio/_components/studio-shell.tsx`

**What to do**: Add a `useEffect` that watches for changes and auto-saves:

```typescript
// Track whether initial load is done (don't save on mount)
const isInitialRender = useRef(true);

// Debounced auto-save
useEffect(() => {
  if (isInitialRender.current) {
    isInitialRender.current = false;
    return;
  }

  const timeoutId = setTimeout(async () => {
    setSaveState("saving");
    try {
      // Save caption preset
      await fetch(`/api/projects/${clipInfo.projectId}/clips/${clipInfo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ captionPreset }),
      });

      // Save transcript
      await fetch(`/api/projects/${clipInfo.projectId}/clips/${clipInfo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ transcriptSlice: utterances }),
      });

      setSaveState("saved");
      setTimeout(() => setSaveState("idle"), 2000);
    } catch {
      setSaveState("idle");
    }
  }, 1500);

  return () => clearTimeout(timeoutId);
}, [utterances, captionPreset, clipInfo.projectId, clipInfo.id]);
```

**Note**: The existing `handleSave` function (line 218) should be updated to perform the same API calls as above, but immediately (no debounce). It serves as a force-save button.

---

## Phase 6: Worker Rendering with Word-Level Captions

### Why
With word-level timing now available, the rendered/exported video should show rapid caption cues (2-3 words at a time) instead of showing the entire utterance for its full duration. This matches the social media caption style users expect.

### Step 6.1: Generate word-level SRT cues

**File**: `apps/worker/src/tasks/render-clips.ts`

**What to do**: Update `generateSrtFromSlice()` (line 214) to optionally use word-level timing.

```typescript
function generateSrtFromSlice(
  utterances: TranscriptUtterance[],
  clipStartSec: number,
): string {
  if (utterances.length === 0) return "";

  const cues: string[] = [];
  let cueIndex = 1;

  for (const utterance of utterances) {
    const words = utterance.words;

    if (words && words.length > 0) {
      // Word-level mode: group into 2-3 word cues
      const WORDS_PER_CUE = 3;
      for (let i = 0; i < words.length; i += WORDS_PER_CUE) {
        const group = words.slice(i, i + WORDS_PER_CUE);
        const start = Math.max(0, group[0]!.startSec - clipStartSec);
        const end = Math.max(start + 0.1, group[group.length - 1]!.endSec - clipStartSec);
        const text = group.map((w) => w.word).join(" ");
        cues.push(`${cueIndex}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${text}\n`);
        cueIndex++;
      }
    } else {
      // Fallback: utterance-level cue (original behavior)
      const start = Math.max(0, utterance.startSec - clipStartSec);
      const end = Math.max(start + 0.1, utterance.endSec - clipStartSec);
      cues.push(`${cueIndex}\n${formatSrtTimestamp(start)} --> ${formatSrtTimestamp(end)}\n${utterance.text}\n`);
      cueIndex++;
    }
  }

  return cues.join("\n");
}
```

### Step 6.2: Support ASS word-level color overrides (future enhancement)

For full browser-to-render parity with `highlightColor`, you'd need to generate ASS subtitle files instead of SRT. ASS supports per-word color tags:

```
{\c&H0088FF00&}HELLO {\c&H00FFFFFF&}WORLD
```

Where the highlighted word uses `highlightColor` converted to BGRA, and non-highlighted words use `primaryColor`.

This is complex to implement correctly (need to generate ASS with word timing + color switching) and is a **future enhancement**. For the initial release, the burned render uses uniform `primaryColor` with rapid word-group cue changes to create the visual effect.

---

## Key Design Decisions Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Time coordinate system | Clip-relative (0 to duration) in UI | Matches existing mock setup, simpler UI logic. Video element translates internally. |
| State management | React Context via StudioShell | Already established pattern, page-scoped state. No need for Zustand/Redux. |
| Save strategy | Debounced auto-save (1500ms) + force-save button | Modern editor UX. Users expect edits to "just save." |
| Video streaming | Presigned R2 URLs with 1-hour TTL | Simple, R2 supports range requests natively for seeking. |
| Word timing recalculation on edit | Proportional redistribution | Redistribute utterance duration equally among new word count. Imperfect but reasonable. |
| Render parity | `highlightColor` and `animation` are preview-only initially | Matches industry standard (Opus Clip, CapCut). Preview is richer than export. |
| Backward compatibility | `words` field optional on utterances | Existing clips without word timing gracefully degrade to full utterance display. |
| Caption animation | Word-by-word only (sliding window) | Most impactful style. Other modes (karaoke, bounce) can be added later. |
| Transcript editing approach | contentEditable div per utterance | Preserves inline rendering, click-to-seek, and natural text editing feel. |

---

## Verification Plan

1. **Phase 1**: Run `normalizeDeepgramTranscript` with a real Deepgram response (or fixture). Verify `words[]` is populated on each utterance with correct `startSec`, `endSec`, `word` values.

2. **Phase 2**: Validate extended `captionPresetSchema` parses:
   - Existing DB values (no new fields) — should pass
   - New fields (`highlightColor`, `animation`, `position: "center"`) — should pass
   - Invalid values — should reject

3. **Phase 3**: Navigate to `/projects/{id}/clips/{clipId}/studio` for a real clip. Verify:
   - Video loads and displays (placeholder gradient disappears)
   - Video starts at `clipStartSec`, not at 0
   - Play/pause controls work
   - `currentTime` in timeline and transcript updates as video plays
   - Video stops at `clipEndSec`
   - Seeking works (clicking timeline, arrow keys)

4. **Phase 4**: Play video with captions. Verify:
   - Caption words appear over the video, synced to speech
   - Active word changes color (`highlightColor`)
   - 2-3 word sliding window advances as speech progresses
   - Changing font/color/position/outline in CaptionsPanel instantly updates the overlay
   - Clips without word timing still show utterance text (fallback)

5. **Phase 5**: Edit transcript. Verify:
   - Clicking a speech block makes it editable
   - Typing changes the text
   - Caption overlay updates to show the edited text
   - Blurring the field triggers save (check network tab for PATCH request)
   - Reloading the page preserves the edit
   - Undo/redo works after edits

6. **Phase 6**: Trigger a render. Download the output video. Verify:
   - Captions appear as rapid 2-3 word cues (not full utterances)
   - Caption styling matches the preset (font, color, outline, shadow, position)
   - Edited transcript text appears in the render (not the original text)
