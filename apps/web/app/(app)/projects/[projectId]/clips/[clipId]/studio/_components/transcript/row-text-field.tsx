"use client";

import { memo, useEffect, useLayoutEffect, useRef, useState } from "react";
import { Box, Textarea } from "@chakra-ui/react";
import { captionTextDirection, languageDirection } from "@narriflow/validators";
import { searchMatches } from "./transcript-search";

/** `lang` and `dir` for transcript text: direction from the text's script balance, else the language's. */
export function textAttributes(text: string, language: string | null) {
  return { lang: language ?? undefined, dir: captionTextDirection(text, language ? languageDirection(language) : undefined) };
}

/** Grows a textarea to fit its text, re-measured when the text or the column's width changes. */
function useAutoHeight(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the text is the trigger — re-measure whenever it changes.
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) fitHeight(el);
  }, [value]);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let width = el.clientWidth;
    const observer = new ResizeObserver(() => {
      if (el.clientWidth === width) return;
      width = el.clientWidth;
      fitHeight(el);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return ref;
}

function fitHeight(el: HTMLTextAreaElement) {
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

// The field and its search marks share every metric, so a mark sits exactly behind its letters.
const textMetrics = {
  px: "8px",
  py: "2px",
  fontSize: "14px",
  whiteSpace: "pre-wrap",
  overflowWrap: "break-word",
  fontFamily: "inherit",
  letterSpacing: "inherit",
} as const;

function SearchMarks({ text, query, lineHeight, attributes }: { text: string; query: string; lineHeight: string; attributes: ReturnType<typeof textAttributes> }) {
  const ranges = searchMatches(text, query);
  if (ranges.length === 0) return null;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start));
    parts.push(
      <Box as="mark" key={start} bg="studio.accentSubtle" color="transparent" borderRadius="3px" boxShadow="0 0 0 1px var(--chakra-colors-studio-accent-subtle)">
        {text.slice(start, end)}
      </Box>,
    );
    at = end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return (
    <Box aria-hidden position="absolute" inset="0" color="transparent" pointerEvents="none" lineHeight={lineHeight} {...attributes} {...textMetrics}>
      {parts}
    </Box>
  );
}

export interface RowTextFieldProps {
  readonly value: string;
  readonly label: string;
  readonly language: string | null;
  readonly readOnly: boolean;
  /** Normalized search query; its matches are marked while the field is not being edited. */
  readonly query: string;
  readonly lineHeight: string;
  /** Enter commits (a caption), or ⌘/Ctrl+Enter does and Enter breaks nothing (a paragraph). */
  readonly submit: "enter" | "mod-enter";
  /**
   * Called when editing starts; returns the commit for this edit, bound to the words the row showed
   * then, so a neighbour's commit regrouping the list does not retarget it.
   */
  readonly beginEdit: () => (text: string) => void;
  readonly onEditingChange?: (editing: boolean) => void;
}

/**
 * A row's text, edited in place: it reads like text until focused, commits on blur or Enter, and
 * Escape restores it. A row keeps its draft while focused, whatever the document does under it.
 */
export const RowTextField = memo(function RowTextField({ value, label, language, readOnly, query, lineHeight, submit, beginEdit, onEditingChange }: RowTextFieldProps) {
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const edit = useRef<{ commit: (text: string) => void; start: string } | null>(null);
  useEffect(() => {
    if (!edit.current) setDraft(value);
  }, [value]);
  const ref = useAutoHeight(draft);
  const attributes = textAttributes(draft, language);
  const finish = (commit: boolean) => {
    const current = edit.current;
    edit.current = null;
    setEditing(false);
    onEditingChange?.(false);
    if (!current) return;
    if (commit && draft.trim() !== current.start.trim()) current.commit(draft);
    else setDraft(value);
  };
  return (
    <Box position="relative" mx="-8px" borderRadius="8px" transition="background 120ms ease" _hover={readOnly ? undefined : { bg: "studio.subtle" }} _focusWithin={{ bg: "studio.raised" }}>
      {query && !editing ? <SearchMarks text={draft} query={query} lineHeight={lineHeight} attributes={attributes} /> : null}
      <Textarea
        ref={ref}
        rows={1}
        value={draft}
        readOnly={readOnly}
        aria-label={label}
        aria-readonly={readOnly || undefined}
        {...attributes}
        {...textMetrics}
        position="relative"
        display="block"
        w="full"
        minH="0"
        lineHeight={lineHeight}
        bg="transparent"
        color="studio.fg"
        borderWidth="0"
        borderRadius="8px"
        resize="none"
        overflow="hidden"
        cursor={readOnly ? "default" : "text"}
        focusVisibleRing="none"
        _focus={{ outline: "none", boxShadow: "none" }}
        _focusVisible={{ outline: "none", boxShadow: "none" }}
        onChange={(event: React.ChangeEvent<HTMLTextAreaElement>) => setDraft(submit === "enter" ? event.target.value.replace(/\n/g, " ") : event.target.value)}
        onFocus={() => {
          if (readOnly) return;
          edit.current = { commit: beginEdit(), start: draft };
          setEditing(true);
          onEditingChange?.(true);
        }}
        onBlur={() => finish(true)}
        onKeyDown={(event: React.KeyboardEvent<HTMLTextAreaElement>) => {
          // Keep the Studio's global shortcuts (Delete, undo, Space) away from typing.
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            finish(false);
            event.currentTarget.blur();
          } else if (event.key === "Enter" && (submit === "enter" || event.metaKey || event.ctrlKey)) {
            event.preventDefault();
            finish(true);
            event.currentTarget.blur();
          }
        }}
      />
    </Box>
  );
});
