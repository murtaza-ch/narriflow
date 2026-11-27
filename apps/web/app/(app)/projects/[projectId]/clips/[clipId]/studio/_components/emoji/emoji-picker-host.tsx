"use client";

import dynamic from "next/dynamic";
import { useMemo, useSyncExternalStore } from "react";
import { Flex, Popover, Portal } from "@chakra-ui/react";
import { Spinner } from "@narriflow/ui/components/spinner";
import type { CaptionEmojiRef } from "@narriflow/validators";
import type { CaptionEmojiLook } from "./emoji-glyph";

// One picker for every emoji control in the Studio: a chip asks for it with its own element as the
// anchor, and a single popover (mounted once) opens beside that chip. One popover instead of one per
// chip keeps the transcript's many rows light. The picker itself is a lazy chunk.

export interface EmojiPickerRequest {
  /** The control that opened the picker: the popover sits beside it and focus returns to it. */
  readonly anchor: HTMLElement;
  /** What the pick applies to, e.g. `Emoji on “money”`. */
  readonly label: string;
  readonly current: CaptionEmojiRef | null;
  /** The clip's emoji palette and Skin tone: designs are drawn as the video will draw them, and the picker opens at that tone. */
  readonly palette: CaptionEmojiLook;
  readonly onPick: (ref: CaptionEmojiRef) => void;
  /** Present when the target has an emoji. */
  readonly onRemove: (() => void) | null;
  /** Opened from an emoji's chip: the words of its line it can move to, left to right, the current one marked. */
  readonly move?: {
    readonly words: readonly { readonly word: number; readonly text: string; readonly current: boolean }[];
    readonly onMove: (word: number) => void;
  };
}

let request: EmojiPickerRequest | null = null;
let lastClosed: { anchor: HTMLElement; at: number } | null = null;
const listeners = new Set<() => void>();

function publish(next: EmojiPickerRequest | null) {
  request = next;
  for (const listener of [...listeners]) listener();
}

/** The open request, or null (tests read what a control asked for). */
export function emojiPickerRequest(): EmojiPickerRequest | null {
  return request;
}

/** A press on the open picker's own anchor closes it (outside press) and must not reopen it at once. */
const REOPEN_GUARD_MS = 300;

export function openEmojiPicker(next: EmojiPickerRequest): void {
  if (request?.anchor === next.anchor) {
    closeEmojiPicker(true);
    return;
  }
  if (lastClosed?.anchor === next.anchor && performance.now() - lastClosed.at < REOPEN_GUARD_MS) return;
  publish(next);
}

export function closeEmojiPicker(restoreFocus: boolean): void {
  const closing = request;
  if (!closing) return;
  lastClosed = { anchor: closing.anchor, at: performance.now() };
  publish(null);
  if (restoreFocus) requestAnimationFrame(() => closing.anchor.isConnected && closing.anchor.focus({ preventScroll: true }));
}

/** The picker is open for this element, so its chip can show it is pressed (only the chips whose answer changes re-render). */
export function useEmojiPickerOpenFor(element: HTMLElement | null): boolean {
  return useSyncExternalStore(subscribe, () => element !== null && request?.anchor === element, () => false);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The picker's height, px: fixed, so typing a search (fewer results) never resizes or moves it. */
export const EMOJI_PICKER_HEIGHT = 408;
const PICKER_GUTTER = 6;

/**
 * Below the chip when the picker fits there, else above when it fits there, else the roomier side.
 * Chosen once when the picker opens: a placement that re-flipped on every layout pass jumped from
 * above the chip to below it as soon as a search started (owner report, ticket 34).
 */
export function emojiPickerPlacement(anchor: { readonly top: number; readonly bottom: number }, viewportHeight: number): "bottom-start" | "top-start" {
  const need = EMOJI_PICKER_HEIGHT + PICKER_GUTTER;
  const below = viewportHeight - anchor.bottom;
  const above = anchor.top;
  if (below >= need) return "bottom-start";
  if (above >= need) return "top-start";
  return below >= above ? "bottom-start" : "top-start";
}

function PickerPending() {
  return (
    <Flex h="full" align="center" justify="center" role="status" aria-label="Loading emojis">
      <Spinner size="sm" />
    </Flex>
  );
}

// Once the chunk is in, the picker renders directly: going through the lazy wrapper again would
// show the fallback first, and React holds a revealed fallback for 300 ms.
let loadedPicker: typeof import("./emoji-picker").EmojiPicker | null = null;
const loadPicker = () =>
  import("./emoji-picker").then((module) => {
    loadedPicker = module.EmojiPicker;
    return module;
  });
const LazyEmojiPicker = dynamic(() => loadPicker().then((module) => module.EmojiPicker), { ssr: false, loading: PickerPending });

/** Fetches the picker's chunk and its first screen of art ahead of the first open (idle time after the emoji controls mount). */
export function warmEmojiPicker(): void {
  void loadPicker().then((module) => module.preloadEmojiPickerArt());
}

/** Mount once per page; it renders nothing until a control opens the picker. */
export function CaptionEmojiPickerHost() {
  const current = useSyncExternalStore(subscribe, () => request, () => null);
  const EmojiPicker = loadedPicker ?? LazyEmojiPicker;
  const anchor = current?.anchor ?? null;
  const placement = useMemo(() => (anchor ? emojiPickerPlacement(anchor.getBoundingClientRect(), window.innerHeight) : "bottom-start"), [anchor]);
  return (
    <Popover.Root
      open={current !== null}
      autoFocus={false}
      lazyMount
      unmountOnExit
      // The side is chosen once per open (`emojiPickerPlacement`), never re-flipped while it is open; it
      // shifts to stay in the window, and `fitViewport` caps the height to the space there
      // (`--available-height`) with the grid scrolling inside.
      positioning={{ placement, gutter: PICKER_GUTTER, flip: false, slide: true, fitViewport: true, getAnchorElement: () => current?.anchor ?? null }}
      onEscapeKeyDown={() => closeEmojiPicker(true)}
      onInteractOutside={() => closeEmojiPicker(false)}
      onOpenChange={(details) => {
        if (!details.open) closeEmojiPicker(false);
      }}
    >
      <Portal>
        {/* The portal leaves the Studio's graphite pin (`studio/layout.tsx`); the same class re-pins the
            app's mode-dependent tokens (the loading spinner) so light mode reads as the Studio does. */}
        <Popover.Positioner className="dark" data-theme="dark">
          <Popover.Content
            w="min(344px, calc(100vw - 24px))"
            p="0"
            bg="studio.surface"
            color="studio.fg"
            borderWidth="0"
            borderRadius="14px"
            boxShadow="none"
            overflow="hidden"
            display="flex"
            flexDirection="column"
            h={`${EMOJI_PICKER_HEIGHT}px`}
            maxH="var(--available-height)"
            aria-label={current?.label ?? "Emoji picker"}
          >
            {current ? <EmojiPicker key={current.label + (current.current?.id ?? "")} request={current} onClose={(restoreFocus) => closeEmojiPicker(restoreFocus)} /> : null}
          </Popover.Content>
        </Popover.Positioner>
      </Portal>
    </Popover.Root>
  );
}
