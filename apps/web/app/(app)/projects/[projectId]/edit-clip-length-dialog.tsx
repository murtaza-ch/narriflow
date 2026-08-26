"use client";

import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import {
  Box,
  Button,
  Dialog,
  Flex,
  IconButton,
  Input,
  Kbd,
  Portal,
  Spinner,
  Text,
} from "@chakra-ui/react";
import { Play, Search, X } from "lucide-react";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { Switch } from "@narriflow/ui/components/switch";
import {
  splitUtterancesIntoSentences,
  userErrorMessage,
  type ClipAspectRatio,
  type TranscriptUtterance,
} from "@narriflow/validators";

const MIN_DURATION_SEC = 10;
const MAX_DURATION_SEC = 120;
/** Word gaps at or above this render as an inline silence chip, mirroring the
 *  transcript's real pauses so users can end a clip on a natural break. */
const SILENCE_CHIP_MIN_SEC = 0.5;
const DENSITY_BUCKETS = 120;
/** Moving the end boundary seeks the player a little BEFORE the new end so
 *  the user immediately hears how the clip will finish. */
const END_AUDITION_LEAD_SEC = 2;

interface FlatWord {
  word: string;
  startSec: number;
  endSec: number;
  sentenceIndex: number;
}

interface Sentence {
  startSec: number;
  firstWordIndex: number;
  wordCount: number;
}

interface FlatTranscript {
  words: FlatWord[];
  sentences: Sentence[];
  sourceDurationSec: number;
}

/** Module-level cache: the source transcript is identical for every clip in a
 *  project, so the second dialog (or a reopen after remount) opens instantly. */
const transcriptCache = new Map<string, FlatTranscript>();
const transcriptPromises = new Map<string, Promise<FlatTranscript>>();

function loadProjectTranscript(projectId: string): Promise<FlatTranscript> {
  const cached = transcriptCache.get(projectId);
  if (cached) return Promise.resolve(cached);

  let pending = transcriptPromises.get(projectId);
  if (!pending) {
    pending = fetch(`/api/projects/${projectId}/transcript/utterances`)
      .then((response) => {
        if (!response.ok) {
          throw new Error(`transcript fetch failed (${response.status})`);
        }
        return response.json() as Promise<{ utterances: TranscriptUtterance[] }>;
      })
      .then((snapshot) => {
        const flat = flatten(splitUtterancesIntoSentences(snapshot.utterances ?? []));
        transcriptCache.set(projectId, flat);
        transcriptPromises.delete(projectId);
        return flat;
      })
      .catch((err) => {
        transcriptPromises.delete(projectId);
        throw err;
      });
    transcriptPromises.set(projectId, pending);
  }
  return pending;
}

function formatClock(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const tenths = Math.floor((safe - Math.floor(safe)) * 10);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${tenths}`;
}

/** mm:ss.cc — the editable-field format (centisecond precision like the API). */
function formatClockCs(seconds: number): string {
  const safe = Math.max(0, seconds);
  const m = Math.floor(safe / 60);
  const s = Math.floor(safe % 60);
  const cs = Math.floor((safe - Math.floor(safe)) * 100);
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}.${String(cs).padStart(2, "0")}`;
}

/** Accepts "95", "1:35", "01:35.2", "1:02:35.25" → seconds, or null. */
function parseClock(text: string): number | null {
  const trimmed = text.trim();
  if (!/^[\d:.]+$/.test(trimmed)) return null;
  const parts = trimmed.split(":");
  if (parts.length > 3 || parts.some((p) => p === "")) return null;
  const nums = parts.map(Number);
  if (nums.some((n) => !Number.isFinite(n) || n < 0)) return null;
  let seconds = 0;
  for (const n of nums) seconds = seconds * 60 + n;
  return seconds;
}

/** Word-index selection covering a [startSec, endSec) window. */
function selectionForWindow(
  words: FlatWord[],
  startSec: number,
  endSec: number,
): { start: number; end: number } {
  let first = words.findIndex((w) => w.endSec > startSec);
  if (first < 0) first = 0;
  let last = -1;
  for (let i = words.length - 1; i >= 0; i--) {
    if (words[i]!.startSec < endSec) {
      last = i;
      break;
    }
  }
  if (last < first) last = first;
  return { start: first, end: last };
}

/** Index of the word whose edge time is closest to `sec`. */
function nearestIndexForTime(
  words: FlatWord[],
  sec: number,
  edge: "start" | "end",
): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < words.length; i++) {
    const t = edge === "start" ? words[i]!.startSec : words[i]!.endSec;
    const d = Math.abs(t - sec);
    if (d < bestDistance) {
      bestDistance = d;
      best = i;
    }
  }
  return best;
}

/** Flattens sentence-level utterances into selectable words. Utterances
 *  without word timings become one pseudo-word spanning the utterance so
 *  they stay selectable. */
function flatten(utterances: TranscriptUtterance[]): FlatTranscript {
  const words: FlatWord[] = [];
  const sentences: Sentence[] = [];

  for (const utterance of utterances) {
    const sentenceIndex = sentences.length;
    const firstWordIndex = words.length;

    if (utterance.words.length > 0) {
      for (const word of utterance.words) {
        words.push({
          word: word.word,
          startSec: word.startSec,
          endSec: word.endSec,
          sentenceIndex,
        });
      }
    } else {
      words.push({
        word: utterance.text,
        startSec: utterance.startSec,
        endSec: utterance.endSec,
        sentenceIndex,
      });
    }

    sentences.push({
      startSec: utterance.startSec,
      firstWordIndex,
      wordCount: words.length - firstWordIndex,
    });
  }

  return {
    words,
    sentences,
    sourceDurationSec: words.at(-1)?.endSec ?? 0,
  };
}

/**
 * Trim / Extend — Vizard-style clip length editor. The full source transcript
 * is the editing surface: the clip's current span is highlighted with caret
 * pins on both edges, clicking a word moves the nearest boundary to it,
 * dragging an edge moves that edge, and dragging elsewhere selects a fresh
 * range. A source-video pane auditions the selection (playback stops at the
 * clip end), the density strip's selection window drags through time, and
 * start/end timecodes are directly editable. Boundaries are word-snapped
 * here and sentence-completed (with collision-safe padding) on save.
 *
 * PERFORMANCE CONTRACT: a source transcript is ~5-10k words. The word list is
 * rendered ONCE as plain spans (no per-word React components, no
 * per-selection re-render); selection highlighting is applied imperatively by
 * toggling classes on exactly the words whose membership changed, and
 * `content-visibility: auto` keeps off-screen rows unpainted. Interaction is
 * geometric hit-testing (elementFromPoint on data-widx spans) — per-word
 * event handlers proved both slow at this scale and unreliable mid-drag.
 * Search highlighting follows the same rule: class toggles on match spans,
 * never a React re-render of the word list.
 */
export function EditClipLengthDialog(props: {
  projectId: string;
  clipId: string;
  clipTitle: string | null;
  initialStartSec: number;
  initialEndSec: number;
  /** Presigned source video; null once the source is purged — the player
   *  pane hides and the dialog stays transcript-only. */
  sourceVideoUrl: string | null;
  /** Formats to re-render when Auto reframe is on: the clip's existing
   *  rendered formats, or the row's selected format for an unrendered clip. */
  renderAspectRatios: ClipAspectRatio[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [autoReframe, setAutoReframe] = useState(true);
  const [flat, setFlat] = useState<FlatTranscript | null>(null);
  const [sel, setSel] = useState<{ start: number; end: number }>({ start: 0, end: 0 });
  const dragState = useRef<
    | { mode: "range"; anchor: number; moved: boolean }
    | { mode: "start" | "end"; moved: boolean }
    | null
  >(null);
  // Callback-ref state, NOT a plain ref: Chakra's Dialog mounts lazy content
  // a machine-tick AFTER `open` flips, so effects keyed on [open, flat] fire
  // against a not-yet-mounted tree. A state-backed ref re-runs them the
  // moment the real DOM exists.
  const [scrollBox, setScrollBox] = useState<HTMLDivElement | null>(null);
  /** Word spans in index order — built once per transcript render, so class
   *  toggles are O(1) array lookups instead of DOM queries. */
  const wordEls = useRef<HTMLElement[]>([]);
  const appliedSel = useRef<{ start: number; end: number } | null>(null);
  /** Painted-but-not-yet-committed selection during a drag. Drags paint the
   *  DOM directly and only commit React state on release (plus a light
   *  mid-drag throttle for the footer readout) — a per-move setState costs a
   *  full dialog re-render per pointer frame, which is what made pin drags
   *  feel slow. */
  const liveSel = useRef<{ start: number; end: number }>({ start: 0, end: 0 });
  const lastDragCommit = useRef(0);

  // Player
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [playheadSec, setPlayheadSec] = useState<number | null>(null);
  const prevSelRef = useRef<{ start: number; end: number } | null>(null);

  // Density-strip window drag
  const stripRef = useRef<HTMLDivElement | null>(null);
  const stripDrag = useRef<{ grabOffsetSec: number; moved: boolean } | null>(null);
  const stripJustDragged = useRef(false);
  const stripRaf = useRef(0);

  // Search
  const [query, setQuery] = useState("");
  const [matchInfo, setMatchInfo] = useState<{ count: number; active: number }>({
    count: 0,
    active: 0,
  });
  const matchIdx = useRef<number[]>([]);
  const activeMatch = useRef(0);

  const words = flat?.words ?? [];
  const selection =
    words.length > 0
      ? {
          startSec: words[sel.start]?.startSec ?? 0,
          endSec: words[sel.end]?.endSec ?? 0,
        }
      : null;
  const durationSec = selection ? selection.endSec - selection.startSec : 0;
  const durationValid =
    durationSec >= MIN_DURATION_SEC && durationSec <= MAX_DURATION_SEC;

  // Editable timecode fields — track selection except while being edited.
  const [startInput, setStartInput] = useState("");
  const [endInput, setEndInput] = useState("");
  const [editingField, setEditingField] = useState<null | "start" | "end">(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: primitive time values intentionally avoid selection object identity churn.
  useEffect(() => {
    if (!selection) return;
    if (editingField !== "start") setStartInput(formatClockCs(selection.startSec));
    if (editingField !== "end") setEndInput(formatClockCs(selection.endSec));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- object identity churns; times are the real deps
  }, [selection?.startSec, selection?.endSec, editingField]);

  // Load + sentence-split the full transcript on first open (module cache
  // makes every later open instant). Guarded by a ref, NOT the loading
  // state: a state dep would re-run this effect and fire the cleanup,
  // cancelling the very fetch it just started.
  const loadStartedRef = useRef(false);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the ref deliberately permits one transcript load per mounted dialog.
  useEffect(() => {
    if (!props.open || loadStartedRef.current) return;
    loadStartedRef.current = true;

    const cached = transcriptCache.get(props.projectId);
    if (cached) {
      setFlat(cached);
      setSel(selectionForWindow(cached.words, props.initialStartSec, props.initialEndSec));
      return;
    }

    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    loadProjectTranscript(props.projectId)
      .then((flattened) => {
        if (cancelled) return;
        setFlat(flattened);
        setSel(
          selectionForWindow(flattened.words, props.initialStartSec, props.initialEndSec),
        );
      })
      .catch((err) => {
        console.error("clip_length_transcript_load_failed", err);
        if (!cancelled) {
          setLoadError("Could not load the transcript.");
          loadStartedRef.current = false; // allow retry on reopen
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot load per open
  }, [props.open]);

  // Every (re)open starts from the clip's CURRENT bounds — the dialog must
  // never carry stale selection state across opens or live refreshes. Closing
  // also pauses the player.
  useEffect(() => {
    if (!props.open) {
      dragState.current = null;
      stripDrag.current = null;
      videoRef.current?.pause();
      return;
    }
    if (!flat) return;
    prevSelRef.current = null; // next commit seeks to the clip start
    setSel(selectionForWindow(flat.words, props.initialStartSec, props.initialEndSec));
    setSaveError(null);
    setQuery("");
  }, [props.open, flat, props.initialStartSec, props.initialEndSec]);

  // The transcript DOM: built exactly once per transcript. Plain elements
  // only — 8k Chakra components took seconds to render and re-rendered on
  // every selection change, which is what made selection feel broken.
  const transcriptDom = useMemo(() => {
    if (!flat) return null;
    return flat.sentences.map((sentence, sentenceIndex) => {
      const nodes: React.ReactNode[] = [];
      for (let offset = 0; offset < sentence.wordCount; offset++) {
        const index = sentence.firstWordIndex + offset;
        const word = flat.words[index]!;
        nodes.push(
          <span key={index} data-widx={index} className="eclw">
            {word.word}
          </span>,
        );
        const next = flat.words[index + 1];
        const gap =
          next && next.sentenceIndex === word.sentenceIndex
            ? next.startSec - word.endSec
            : 0;
        if (gap >= SILENCE_CHIP_MIN_SEC) {
          nodes.push(
            <span key={`g${index}`} className="eclgap">
              [{gap.toFixed(1)}s]
            </span>,
          );
        }
        nodes.push(" ");
      }
      return (
        <div key={sentenceIndex} className="eclrow" data-sentence={sentenceIndex}>
          <span className="ecltc">{formatClock(sentence.startSec)}</span>
          <span className="eclbody">{nodes}</span>
        </div>
      );
    });
  }, [flat]);

  // Index the word spans once the transcript DOM exists — re-run on open so
  // a remount (dialog implementations may recreate content) can never leave
  // us holding detached elements.
  useLayoutEffect(() => {
    if (!props.open || !flat || !scrollBox) return;
    const els = scrollBox.querySelectorAll<HTMLElement>("[data-widx]");
    if (els.length === 0) return;
    if (wordEls.current[0]?.isConnected && els.length === wordEls.current.length) {
      return; // same live DOM, keep the index and painted selection
    }
    const list: HTMLElement[] = new Array(els.length);
    els.forEach((el) => {
      list[Number(el.dataset.widx)] = el;
    });
    wordEls.current = list;
    appliedSel.current = null; // force a full selection paint
  }, [flat, props.open, scrollBox]);

  // Imperative selection paint: toggle classes only on the words whose
  // selection membership changed — a one-word edge drag touches ~2 nodes.
  // Callable from pointer handlers directly (drags bypass React entirely).
  const paintSelection = useCallback((next: { start: number; end: number }) => {
    const els = wordEls.current;
    if (els.length === 0) return;
    const prev = appliedSel.current;
    if (prev && prev.start === next.start && prev.end === next.end) return;
    const inPrev = (i: number) => prev !== null && i >= prev.start && i <= prev.end;
    const inNext = (i: number) => i >= next.start && i <= next.end;

    const lo = Math.min(prev?.start ?? 0, next.start);
    const hi = Math.max(prev?.end ?? els.length - 1, next.end);
    for (let i = lo; i <= hi; i++) {
      const was = inPrev(i);
      const is = inNext(i);
      if (was !== is) els[i]?.classList.toggle("sel", is);
    }
    if (prev) {
      els[prev.start]?.classList.remove("es");
      els[prev.end]?.classList.remove("ee");
    }
    if (prev === null) {
      // First paint after (re)mount: apply the whole range.
      for (let i = next.start; i <= next.end; i++) els[i]?.classList.add("sel");
    }
    els[next.start]?.classList.add("es");
    els[next.end]?.classList.add("ee");
    appliedSel.current = next;
  }, []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollBox intentionally repaints when the callback ref attaches.
  useLayoutEffect(() => {
    if (!flat) return;
    // Mid-drag, throttled commits lag the imperatively-painted DOM — never
    // repaint backwards from stale state; the drag handlers own the paint.
    if (dragState.current) return;
    paintSelection(sel);
    liveSel.current = sel;
  }, [sel, flat, scrollBox, paintSelection]);

  // Bring the selection into view when the dialog opens.
  // biome-ignore lint/correctness/useExhaustiveDependencies: opening or mounting the transcript is the deliberate scroll trigger.
  useEffect(() => {
    if (!props.open || !flat || !scrollBox) return;
    const frame = requestAnimationFrame(() => {
      wordEls.current[sel.start]?.scrollIntoView({ block: "center" });
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- scroll on open only
  }, [props.open, flat, scrollBox]);

  // Seek the player when a boundary change COMMITS (never mid-drag): end-edge
  // changes audition the new ending, everything else cues the new start.
  // Gesture handlers finish with an identity poke (`setSel(cur => ({...cur}))`)
  // so this effect runs once after the drag settles.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sel is the commit trigger; selection is derived from that same range.
  useEffect(() => {
    if (!flat || !selection) return;
    if (dragState.current || stripDrag.current) return;
    const prev = prevSelRef.current;
    prevSelRef.current = sel;
    if (prev && prev.start === sel.start && prev.end === sel.end) return;
    const auditionEnd = prev !== null && prev.start === sel.start && prev.end !== sel.end;
    const target = auditionEnd
      ? Math.max(selection.startSec, selection.endSec - END_AUDITION_LEAD_SEC)
      : selection.startSec;
    const video = videoRef.current;
    if (video) {
      try {
        video.currentTime = target;
      } catch {
        // metadata not ready yet — the onLoadedMetadata cue covers first load
      }
    }
    setPlayheadSec(target);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- sel is the trigger; selection derives from it
  }, [sel, flat]);

  // Search: imperative .hit / .hita class toggles over the word index —
  // same no-re-render rule as selection. Debounced a frame's worth.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scrollBox intentionally reapplies search highlighting after remount.
  useEffect(() => {
    const handle = setTimeout(() => {
      const els = wordEls.current;
      for (const i of matchIdx.current) {
        els[i]?.classList.remove("hit", "hita");
      }
      const q = query.trim().toLowerCase();
      if (!flat || q.length < 2 || els.length === 0) {
        matchIdx.current = [];
        setMatchInfo({ count: 0, active: 0 });
        return;
      }
      const found: number[] = [];
      for (let i = 0; i < flat.words.length; i++) {
        if (flat.words[i]!.word.toLowerCase().includes(q)) found.push(i);
      }
      for (const i of found) els[i]?.classList.add("hit");
      matchIdx.current = found;
      activeMatch.current = 0;
      setMatchInfo({ count: found.length, active: 0 });
      if (found.length > 0) {
        els[found[0]!]?.classList.add("hita");
        els[found[0]!]?.scrollIntoView({ block: "center" });
      }
    }, 120);
    return () => clearTimeout(handle);
  }, [query, flat, scrollBox]);

  // Ref-driven, side effects OUTSIDE the state updater — updaters must stay
  // pure (React double-invokes them in dev, and the original selection bug
  // came from exactly this pattern).
  const cycleMatch = useCallback((direction: 1 | -1) => {
    const found = matchIdx.current;
    if (found.length === 0) return;
    const els = wordEls.current;
    const prev = activeMatch.current;
    const next = (prev + direction + found.length) % found.length;
    activeMatch.current = next;
    els[found[prev]!]?.classList.remove("hita");
    els[found[next]!]?.classList.add("hita");
    els[found[next]!]?.scrollIntoView({ block: "center" });
    setMatchInfo({ count: found.length, active: next });
  }, []);

  const wordIndexAtPoint = useCallback((x: number, y: number): number | null => {
    const el = document.elementFromPoint(x, y)?.closest("[data-widx]");
    if (!el) return null;
    const parsed = Number((el as HTMLElement).dataset.widx);
    return Number.isFinite(parsed) ? parsed : null;
  }, []);

  // Runs synchronously in pointermove (the browser already coalesces moves to
  // frame rate): paints the DOM immediately, commits React state at most
  // every ~120ms so the footer readout tracks without a per-frame re-render.
  const extendDrag = useCallback(
    (index: number) => {
      const drag = dragState.current;
      if (!drag) return;
      // Jitter guard: a click's 1-2px wobble resolves to the same word and
      // must stay a click — not collapse the selection to one word.
      if (drag.mode === "range" && index === drag.anchor && !drag.moved) return;
      drag.moved = true;
      const cur = liveSel.current;
      const next =
        drag.mode === "range"
          ? { start: Math.min(drag.anchor, index), end: Math.max(drag.anchor, index) }
          : drag.mode === "start"
            ? { start: Math.min(index, cur.end), end: cur.end }
            : { start: cur.start, end: Math.max(index, cur.start) };
      if (next.start === cur.start && next.end === cur.end) return;
      liveSel.current = next;
      paintSelection(next);
      const now = performance.now();
      if (now - lastDragCommit.current > 120) {
        lastDragCommit.current = now;
        setSel(next);
      }
    },
    [paintSelection],
  );

  // The pointer-up position decides the FINAL selection synchronously — a
  // fast flick can land down→moves→up inside a single frame. Bases every
  // computation on liveSel (React state may be a throttle-step behind) and
  // always commits with setSel, which runs the seek effect.
  const endDrag = useCallback((index: number | null) => {
    const drag = dragState.current;
    dragState.current = null;
    if (!drag) return;
    const cur = liveSel.current;
    if (index === null) {
      if (drag.moved) setSel({ ...cur });
      return;
    }
    let next: { start: number; end: number };
    if (drag.mode !== "range") {
      next =
        drag.mode === "start"
          ? { start: Math.min(index, cur.end), end: cur.end }
          : { start: cur.start, end: Math.max(index, cur.start) };
    } else if (drag.moved || index !== drag.anchor) {
      next = { start: Math.min(drag.anchor, index), end: Math.max(drag.anchor, index) };
    } else {
      // A plain click (down + up on the same word, no movement) moves the
      // NEAREST edge to that word.
      const distStart = Math.abs(index - cur.start);
      const distEnd = Math.abs(index - cur.end);
      next =
        distStart <= distEnd
          ? { start: Math.min(index, cur.end), end: cur.end }
          : { start: cur.start, end: Math.max(index, cur.start) };
    }
    liveSel.current = next;
    setSel(next);
  }, []);

  async function handleSave() {
    if (!selection || !durationValid || saving) return;
    setSaving(true);
    setSaveError(null);
    try {
      const response = await fetch(
        `/api/projects/${props.projectId}/clips/${props.clipId}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            startSec: selection.startSec,
            endSec: selection.endSec,
          }),
        },
      );
      if (!response.ok) {
        const body = await response.json().catch(() => null);
        console.error("clip_length_save_failed", response.status, body);
        setSaveError(
          userErrorMessage(body?.error) ?? "Could not save the new clip length.",
        );
        return;
      }
      // The trimmed clip's old renders are gone (the save invalidates them);
      // Auto reframe immediately queues fresh ones so the clip comes back in
      // its formats with the reframing pass applied.
      if (autoReframe && props.renderAspectRatios.length > 0) {
        const renderResponse = await fetch(
          `/api/projects/${props.projectId}/clips/render`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "idempotency-key": crypto.randomUUID(),
            },
            body: JSON.stringify({
              clipIds: [props.clipId],
              aspectRatios: props.renderAspectRatios,
            }),
          },
        );
        if (!renderResponse.ok) {
          const body = await renderResponse.json().catch(() => null);
          console.error("clip_length_reframe_queue_failed", renderResponse.status, body);
          // The trim itself saved — surface the queue failure without
          // closing so the user can retry from the row's Render button.
          setSaveError(
            userErrorMessage(body?.error) ??
              "Trim saved, but reframing could not be queued.",
          );
          startTransition(() => router.refresh());
          return;
        }
      }
      props.onOpenChange(false);
      startTransition(() => router.refresh());
    } catch (err) {
      console.error("clip_length_save_failed", err);
      setSaveError("Could not save the new clip length.");
    } finally {
      setSaving(false);
    }
  }

  const saveFromShortcut = useEffectEvent(handleSave);

  // ⌘S / Ctrl+S saves while the dialog is open (matches the button hint).
  useEffect(() => {
    if (!props.open) return;
    const onKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void saveFromShortcut();
      }
    };
    window.addEventListener("keydown", onKeydown);
    return () => window.removeEventListener("keydown", onKeydown);
  }, [props.open]);

  function commitTimecode(field: "start" | "end") {
    setEditingField(null);
    if (!flat || !selection) return;
    const parsed = parseClock(field === "start" ? startInput : endInput);
    if (parsed === null) {
      // Revert to the live value.
      if (field === "start") setStartInput(formatClockCs(selection.startSec));
      else setEndInput(formatClockCs(selection.endSec));
      return;
    }
    if (field === "start") {
      const index = nearestIndexForTime(flat.words, parsed, "start");
      setSel((cur) => ({ start: Math.min(index, cur.end), end: cur.end }));
    } else {
      const index = nearestIndexForTime(flat.words, parsed, "end");
      setSel((cur) => ({ start: cur.start, end: Math.max(index, cur.start) }));
    }
  }

  function togglePlay() {
    const video = videoRef.current;
    if (!video || !selection) return;
    if (playing) {
      video.pause();
      return;
    }
    if (
      video.currentTime < selection.startSec - 0.05 ||
      video.currentTime >= selection.endSec - 0.05
    ) {
      video.currentTime = selection.startSec;
    }
    void video.play();
  }

  // Speech-density strip: drawn structure — spoken-time coverage per bucket
  // over the whole source. The selection window and playhead are separate
  // positioned overlays so the bars never re-render.
  const densityBars = useMemo(() => {
    if (!flat || flat.sourceDurationSec <= 0) return null;
    const total = flat.sourceDurationSec;
    const buckets = new Array<number>(DENSITY_BUCKETS).fill(0);
    for (const word of flat.words) {
      const from = Math.max(
        0,
        Math.min(DENSITY_BUCKETS - 1, Math.floor((word.startSec / total) * DENSITY_BUCKETS)),
      );
      const to = Math.max(
        0,
        Math.min(DENSITY_BUCKETS - 1, Math.floor((word.endSec / total) * DENSITY_BUCKETS)),
      );
      for (let b = from; b <= to; b++) buckets[b] = Math.min(1, buckets[b]! + 0.34);
    }
    return buckets;
  }, [flat]);

  const stripSecAtPointer = useCallback(
    (clientX: number): number | null => {
      const rect = stripRef.current?.getBoundingClientRect();
      if (!rect || !flat || flat.sourceDurationSec <= 0 || rect.width === 0) return null;
      const fraction = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return fraction * flat.sourceDurationSec;
    },
    [flat],
  );

  const handleStripJump = useCallback(
    (clientX: number) => {
      if (!flat) return;
      const targetSec = stripSecAtPointer(clientX);
      if (targetSec === null) return;
      const sentence = flat.sentences.reduce((best, s) =>
        Math.abs(s.startSec - targetSec) < Math.abs(best.startSec - targetSec) ? s : best,
      );
      const el = scrollBox?.querySelector(
        `[data-sentence="${flat.sentences.indexOf(sentence)}"]`,
      );
      el?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
    [flat, scrollBox, stripSecAtPointer],
  );

  const totalSec = flat?.sourceDurationSec ?? 0;
  const windowLeftPct = selection && totalSec > 0 ? (selection.startSec / totalSec) * 100 : 0;
  const windowWidthPct =
    selection && totalSec > 0
      ? Math.max(0.4, ((selection.endSec - selection.startSec) / totalSec) * 100)
      : 0;
  const playheadPct =
    playheadSec !== null && totalSec > 0
      ? Math.min(100, Math.max(0, (playheadSec / totalSec) * 100))
      : null;

  const clipElapsedSec =
    playheadSec !== null && selection
      ? Math.min(durationSec, Math.max(0, playheadSec - selection.startSec))
      : 0;

  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(e) => props.onOpenChange(e.open)}
      placement="center"
      // Mount the content on first open, then KEEP it mounted: rebuilding
      // an ~8k-word DOM on every open is exactly the jank this component's
      // performance contract forbids, and remounts would orphan the indexed
      // word elements.
      lazyMount
      unmountOnExit={false}
    >
      <Portal>
        <Dialog.Backdrop bg="rgba(0,0,0,0.6)" zIndex={300} />
        <Dialog.Positioner zIndex={310}>
          <Dialog.Content
            layerStyle="panel"
            borderRadius="l3"
            w="min(1180px, 96vw)"
            maxW="min(1180px, 96vw)"
            h="min(740px, 92vh)"
            overflow="hidden"
            display="flex"
            flexDirection="column"
          >
            {/* Header */}
            <Flex
              align="center"
              justify="space-between"
              px="5"
              py="3"
              borderBottomWidth="1px"
              borderColor="border.subtle"
            >
              <Box>
                <Text textStyle="eyebrow" color="fg.subtle">
                  Trim / Extend
                </Text>
                <Text textStyle="title" fontSize="15px" color="fg">
                  {props.clipTitle ?? "Edit clip length"}
                </Text>
              </Box>
              <Dialog.CloseTrigger asChild>
                <Button variant="ghost" size="xs" aria-label="Close">
                  <X size={14} />
                </Button>
              </Dialog.CloseTrigger>
            </Flex>

            <Flex flex="1" minH="0">
              {/* Player pane — auditions the selection against the source. */}
              {props.sourceVideoUrl && (
                <Flex
                  direction="column"
                  justify="center"
                  w="clamp(280px, 34%, 400px)"
                  flexShrink={0}
                  p="4"
                  gap="3"
                  borderRightWidth="1px"
                  borderColor="border.subtle"
                >
                  <MediaWell
                    ratio={16 / 9}
                    w="full"
                    timecode={`${formatClock(clipElapsedSec)} / ${formatClock(durationSec)}`}
                  >
                    {/* biome-ignore lint/a11y/useMediaCaption: the transcript IS the caption surface */}
                    <video
                      ref={videoRef}
                      src={props.sourceVideoUrl}
                      preload="metadata"
                      style={{
                        position: "absolute",
                        inset: 0,
                        width: "100%",
                        height: "100%",
                        objectFit: "contain",
                        cursor: "pointer",
                      }}
                      onClick={togglePlay}
                      onPlay={() => setPlaying(true)}
                      onPause={() => setPlaying(false)}
                      onLoadedMetadata={(e) => {
                        if (selection) {
                          e.currentTarget.currentTime = selection.startSec;
                          setPlayheadSec(selection.startSec);
                        }
                      }}
                      onTimeUpdate={(e) => {
                        const t = e.currentTarget.currentTime;
                        setPlayheadSec(t);
                        if (selection && t >= selection.endSec) {
                          e.currentTarget.pause();
                          e.currentTarget.currentTime = selection.startSec;
                          setPlayheadSec(selection.startSec);
                        }
                      }}
                    />
                    {!playing && (
                      <Flex
                        position="absolute"
                        inset="0"
                        align="center"
                        justify="center"
                        pointerEvents="none"
                      >
                        <IconButton
                          aria-label="Play selection"
                          size="lg"
                          borderRadius="full"
                          bg="rgba(14, 16, 19, 0.72)"
                          color="white"
                          _hover={{ bg: "rgba(14, 16, 19, 0.85)" }}
                          pointerEvents="auto"
                          onClick={togglePlay}
                        >
                          <Play size={20} />
                        </IconButton>
                      </Flex>
                    )}
                  </MediaWell>
                </Flex>
              )}

              {/* Transcript column */}
              <Flex direction="column" flex="1" minW="0">
                {/* Search */}
                <Flex
                  align="center"
                  gap="2"
                  px="5"
                  py="2"
                  borderBottomWidth="1px"
                  borderColor="border.subtle"
                >
                  <Search size={13} color="var(--chakra-colors-fg-subtle)" />
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        cycleMatch(e.shiftKey ? -1 : 1);
                      }
                    }}
                    placeholder="Search transcript"
                    size="xs"
                    variant="flushed"
                    borderColor="transparent"
                    flex="1"
                  />
                  {query.trim().length >= 2 && (
                    <Text textStyle="data" fontSize="11px" color="fg.timecode" flexShrink={0}>
                      {matchInfo.count === 0
                        ? "0 matches"
                        : `${matchInfo.active + 1}/${matchInfo.count}`}
                    </Text>
                  )}
                </Flex>

                {/* Transcript surface — all selection interaction lives here via
                    geometric hit-testing; the word list itself never re-renders. */}
                <Box
                  ref={setScrollBox}
                  flex="1"
                  minH="0"
                  overflowY="auto"
                  px="5"
                  py="4"
                  userSelect="none"
                  css={{
                    "& .eclrow": {
                      display: "flex",
                      gap: "12px",
                      // content-visibility implies PAINT CONTAINMENT: anything a
                      // child paints above the row box (the caret pin dots) gets
                      // clipped. The top padding keeps the pins inside the box.
                      paddingTop: "7px",
                      marginBottom: "7px",
                      // Off-screen rows are neither laid out nor painted — the
                      // difference between an instant open and a seconds-long one.
                      contentVisibility: "auto",
                      containIntrinsicSize: "auto 55px",
                    },
                    "& .ecltc": {
                      fontFamily: "var(--chakra-fonts-mono)",
                      fontSize: "11px",
                      color: "var(--chakra-colors-fg-timecode)",
                      flexShrink: 0,
                      width: "52px",
                      textAlign: "right",
                      paddingTop: "2px",
                    },
                    "& .eclbody": {
                      fontSize: "14px",
                      lineHeight: 1.8,
                      color: "var(--chakra-colors-fg-muted)",
                    },
                    "& .eclgap": {
                      fontFamily: "var(--chakra-fonts-mono)",
                      fontSize: "10px",
                      color: "var(--chakra-colors-fg-timecode)",
                      margin: "0 4px",
                    },
                    "& .eclw": {
                      position: "relative",
                      cursor: "pointer",
                      borderRadius: "2px",
                      padding: "0 1px",
                    },
                    "& .eclw.sel": {
                      background: "var(--chakra-colors-accent-muted)",
                      color: "var(--chakra-colors-fg)",
                    },
                    "& .eclw.hit": {
                      textDecoration: "underline",
                      textDecorationColor: "var(--chakra-colors-accent-solid)",
                      textDecorationThickness: "2px",
                      textUnderlineOffset: "3px",
                    },
                    "& .eclw.hita": {
                      background: "var(--chakra-colors-accent-solid)",
                      color: "var(--chakra-colors-accent-contrast)",
                    },
                    // Edge carets: Vizard-style pins — bar through the text
                    // line with a grab dot on top. Bars are inset box-shadows,
                    // NOT borders: borders add width and shift the whole line
                    // every time a pin moves.
                    "& .eclw.es": {
                      boxShadow: "inset 2px 0 0 var(--chakra-colors-accent-solid)",
                      cursor: "ew-resize",
                    },
                    "& .eclw.ee": {
                      boxShadow: "inset -2px 0 0 var(--chakra-colors-accent-solid)",
                      cursor: "ew-resize",
                    },
                    // Single-word selection: the word is both edges at once.
                    "& .eclw.es.ee": {
                      boxShadow:
                        "inset 2px 0 0 var(--chakra-colors-accent-solid), inset -2px 0 0 var(--chakra-colors-accent-solid)",
                    },
                    "& .eclw.es::before, & .eclw.ee::after": {
                      content: '""',
                      position: "absolute",
                      top: "-6px",
                      width: "7px",
                      height: "7px",
                      borderRadius: "50%",
                      background: "var(--chakra-colors-accent-solid)",
                    },
                    "& .eclw.es::before": { insetInlineStart: "-2px" },
                    "& .eclw.ee::after": { insetInlineEnd: "-2px" },
                  }}
                  onPointerDown={(e) => {
                    const index = wordIndexAtPoint(e.clientX, e.clientY);
                    if (index === null) return;
                    e.preventDefault();
                    // Capture so the drag survives leaving the box. Throws
                    // InvalidPointerId for some synthetic pointers — the drag
                    // must start regardless.
                    try {
                      e.currentTarget.setPointerCapture(e.pointerId);
                    } catch {
                      // non-capturable pointer; bubbling still delivers events
                    }
                    const cur = appliedSel.current ?? sel;
                    liveSel.current = cur;
                    lastDragCommit.current = performance.now();
                    dragState.current =
                      index === cur.end
                        ? { mode: "end", moved: false }
                        : index === cur.start
                          ? { mode: "start", moved: false }
                          : { mode: "range", anchor: index, moved: false };
                  }}
                  onPointerMove={(e) => {
                    if (!dragState.current) return;
                    // Synchronous: the browser already coalesces pointer moves
                    // to frame rate, and deferring to rAF added a frame of lag.
                    const index = wordIndexAtPoint(e.clientX, e.clientY);
                    if (index !== null) extendDrag(index);
                  }}
                  onPointerUp={(e) => endDrag(wordIndexAtPoint(e.clientX, e.clientY))}
                  onPointerCancel={() => {
                    dragState.current = null;
                  }}
                >
                  {loading && (
                    <Flex align="center" justify="center" h="full" gap="2">
                      <Spinner size="sm" />
                      <Text fontSize="sm" color="fg.muted">
                        Loading transcript…
                      </Text>
                    </Flex>
                  )}
                  {loadError && (
                    <Flex align="center" justify="center" h="full">
                      <Text fontSize="sm" color="danger.fg">
                        {loadError}
                      </Text>
                    </Flex>
                  )}
                  {transcriptDom}
                </Box>
              </Flex>
            </Flex>

            {/* Speech-density strip: click to jump the transcript, drag the
                selection window to move the clip through time. */}
            {flat && densityBars && selection && totalSec > 0 && (
              <Box
                ref={stripRef}
                position="relative"
                mx="5"
                mt="2"
                mb="1"
                h="36px"
                cursor="pointer"
                title="Click to jump · drag the window to move the clip"
                onClick={(e) => {
                  // A finished window drag also emits a click — swallow it.
                  if (stripDrag.current || stripJustDragged.current) {
                    stripJustDragged.current = false;
                    return;
                  }
                  handleStripJump(e.clientX);
                }}
                // Window-drag move/end live on the WIDE container, not the
                // (tiny) window div: if pointer capture fails the gesture
                // still tracks, and stripDrag can never go stale.
                onPointerMove={(e) => {
                  if (!stripDrag.current || !flat || !selection) return;
                  const { clientX } = e;
                  cancelAnimationFrame(stripRaf.current);
                  stripRaf.current = requestAnimationFrame(() => {
                    const drag = stripDrag.current;
                    const pointerSec = stripSecAtPointer(clientX);
                    if (!drag || pointerSec === null) return;
                    drag.moved = true;
                    const duration = selection.endSec - selection.startSec;
                    const nextStart = Math.min(
                      Math.max(0, pointerSec - drag.grabOffsetSec),
                      Math.max(0, totalSec - duration),
                    );
                    setSel(selectionForWindow(flat.words, nextStart, nextStart + duration));
                  });
                }}
                onPointerUp={(e) => {
                  const drag = stripDrag.current;
                  stripDrag.current = null;
                  cancelAnimationFrame(stripRaf.current);
                  if (!drag || !flat || !selection) return;
                  // Resolve the final window position from the pointer-up
                  // coordinate itself — a flick can finish before any rAF
                  // move ever ran.
                  const pointerSec = stripSecAtPointer(e.clientX);
                  if (pointerSec === null) return;
                  const duration = selection.endSec - selection.startSec;
                  const nextStart = Math.min(
                    Math.max(0, pointerSec - drag.grabOffsetSec),
                    Math.max(0, totalSec - duration),
                  );
                  if (!drag.moved && Math.abs(nextStart - selection.startSec) < 0.25) {
                    return; // stationary press on the window — let onClick jump
                  }
                  stripJustDragged.current = true;
                  const next = selectionForWindow(
                    flat.words,
                    nextStart,
                    nextStart + duration,
                  );
                  setSel(next);
                  requestAnimationFrame(() => {
                    wordEls.current[next.start]?.scrollIntoView({ block: "center" });
                  });
                }}
                onPointerCancel={() => {
                  stripDrag.current = null;
                }}
              >
                {/* biome-ignore lint/a11y/noSvgWithoutTitle: decorative speech-density strip; the timecode inputs and transcript convey the same information. */}
                <svg
                  width="100%"
                  height="36"
                  preserveAspectRatio="none"
                  viewBox={`0 0 ${DENSITY_BUCKETS} 36`}
                  style={{ display: "block" }}
                >
                  {densityBars.map((v, i) => (
                    <rect
                      key={i}
                      x={i + 0.15}
                      width={0.7}
                      y={18 - v * 15}
                      height={Math.max(1.5, v * 30)}
                      rx={0.3}
                      fill="var(--chakra-colors-border-emphasized)"
                    />
                  ))}
                </svg>
                {/* Draggable selection window */}
                <Box
                  position="absolute"
                  top="0"
                  bottom="0"
                  left={`${windowLeftPct}%`}
                  width={`${windowWidthPct}%`}
                  borderWidth="1.5px"
                  borderColor="accent.solid"
                  borderRadius="l1"
                  bg="accent.muted"
                  opacity={0.85}
                  cursor="grab"
                  _active={{ cursor: "grabbing" }}
                  onPointerDown={(e) => {
                    if (!selection) return;
                    const pointerSec = stripSecAtPointer(e.clientX);
                    if (pointerSec === null) return;
                    e.preventDefault();
                    try {
                      stripRef.current?.setPointerCapture(e.pointerId);
                    } catch {
                      // non-capturable pointer; the container still receives
                      // moves while the pointer stays over the strip
                    }
                    stripDrag.current = {
                      grabOffsetSec: pointerSec - selection.startSec,
                      moved: false,
                    };
                  }}
                />
                {/* Playhead */}
                {playheadPct !== null && (
                  <Box
                    position="absolute"
                    top="0"
                    bottom="0"
                    left={`${playheadPct}%`}
                    width="1.5px"
                    bg="fg"
                    opacity={0.7}
                    pointerEvents="none"
                  />
                )}
              </Box>
            )}

            {/* Footer */}
            <Flex
              align="center"
              justify="space-between"
              gap="3"
              px="5"
              py="3"
              borderTopWidth="1px"
              borderColor="border.subtle"
              wrap="wrap"
            >
              <Flex align="center" gap="3" wrap="wrap">
                <Flex align="center" gap="1.5">
                  <Input
                    value={startInput}
                    onChange={(e) => setStartInput(e.target.value)}
                    onFocus={() => setEditingField("start")}
                    onBlur={() => commitTimecode("start")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setEditingField(null);
                        if (selection) setStartInput(formatClockCs(selection.startSec));
                      }
                    }}
                    aria-label="Clip start timecode"
                    size="xs"
                    w="76px"
                    textAlign="center"
                    fontFamily="mono"
                    fontSize="11px"
                    borderColor="border.control"
                    disabled={!flat}
                  />
                  <Text fontSize="11px" color="fg.subtle">
                    –
                  </Text>
                  <Input
                    value={endInput}
                    onChange={(e) => setEndInput(e.target.value)}
                    onFocus={() => setEditingField("end")}
                    onBlur={() => commitTimecode("end")}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur();
                      if (e.key === "Escape") {
                        setEditingField(null);
                        if (selection) setEndInput(formatClockCs(selection.endSec));
                      }
                    }}
                    aria-label="Clip end timecode"
                    size="xs"
                    w="76px"
                    textAlign="center"
                    fontFamily="mono"
                    fontSize="11px"
                    borderColor="border.control"
                    disabled={!flat}
                  />
                  <Text textStyle="data" fontSize="12px" color="fg.timecode" ms="1">
                    · {durationSec.toFixed(1)}s
                  </Text>
                </Flex>
                <Box maxW="420px">
                  {flat && !durationValid && (
                    <Text fontSize="11px" color="danger.fg">
                      {`Clips must be ${MIN_DURATION_SEC}–${MAX_DURATION_SEC} seconds (currently ${durationSec.toFixed(1)}s).`}
                    </Text>
                  )}
                  {saveError && (
                    <Text fontSize="11px" color="danger.fg" mt="0.5">
                      {saveError}
                    </Text>
                  )}
                </Box>
              </Flex>
              <Flex gap="3" align="center" flexShrink={0}>
                <Switch
                  checked={autoReframe}
                  onCheckedChange={setAutoReframe}
                  disabled={saving}
                >
                  Auto reframe
                </Switch>
                <Button variant="outline" size="sm" onClick={() => props.onOpenChange(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  onClick={handleSave}
                  disabled={!selection || !durationValid || saving || loading}
                >
                  {saving ? "Saving…" : "Save"}
                  {!saving && (
                    <Kbd ms="1.5" fontSize="10px" opacity={0.8}>
                      ⌘S
                    </Kbd>
                  )}
                </Button>
              </Flex>
            </Flex>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
