"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Box, Dialog, Flex, Input, Portal, Stack, Text } from "@chakra-ui/react";
import { Eye, EyeOff, Plus, RotateCcw, Search, ShieldCheck, Sparkles, X } from "lucide-react";
import { toaster } from "@narriflow/ui/components/toaster";
import {
  censorTermIssue,
  censorWildcardStem,
  censorWordCategory,
  CENSOR_TERM_MAX_LENGTH,
  DEFAULT_CENSOR_WORD_LIST,
  detectAutoCensorSuggestions,
  maskCensorTermForDisplay,
  maskCensoredCaptionWord,
  PROJECT_CENSOR_TERMS_MAX,
  WORKSPACE_CENSOR_WORDS_MAX,
  type WorkspaceCensorWords,
} from "@narriflow/validators";
import { apiErrorMessage } from "@/app/_components/query-mutation-form";

/**
 * The censored-word list editor: the Workspace list (shared by every project),
 * an optional Project list, and the Brand kit's blocked terms, read-only. One
 * dialog serves the Studio (graphite) and Settings (the app's own theme).
 *
 * One field both searches the list and adds to it (several words at once when
 * pasted with commas or lines). Edits show at once and roll back if the save
 * fails; a removal can be undone from its toast. The tester at the bottom runs
 * the real detector over a typed line, so wildcards and phrases can be checked
 * before a clip is.
 */

type Tone = "studio" | "app";

const TONES = {
  studio: {
    surface: "studio.surface",
    fg: "studio.fg",
    muted: "studio.fgMuted",
    subtle: "studio.fgSubtle",
    soft: "studio.subtle",
    chip: "studio.raised",
    chipHover: "studio.borderStrong",
    danger: "studio.danger",
    accent: "studio.accent",
    accentFg: "studio.accentFg",
    accentSoft: "studio.accentSubtle",
  },
  app: {
    surface: "bg.dialog",
    fg: "fg",
    muted: "fg.muted",
    subtle: "fg.subtle",
    soft: "bg.subtle",
    chip: "bg.soft",
    chipHover: "bg.muted",
    danger: "danger.fg",
    accent: "accent.solid",
    accentFg: "accent.fg",
    accentSoft: "accent.subtle",
  },
} as const;

const FIELD_FOCUS = { outline: "none", boxShadow: "none" } as const;
const UNCHANGED = "Try again. Your list is unchanged.";
const DEFAULT_TERMS = new Set(DEFAULT_CENSOR_WORD_LIST.map(foldedTerm));

/**
 * The Workspace list and how to change it. The save and reset callbacks are the
 * caller's API mutations; they resolve with the stored list and reject with the
 * API's error.
 */
export interface WorkspaceCensorWordsEditor {
  words: readonly string[];
  /** The server's flag: whether the Workspace has edited its list. Reset follows it. */
  customized: boolean;
  canEdit: boolean;
  save: (words: string[]) => Promise<unknown>;
  reset: () => Promise<unknown>;
  onChange: (state: WorkspaceCensorWords) => void;
}

export interface ProjectCensorTerms {
  terms: readonly string[];
  canEdit: boolean;
  /** Saves the whole list and resolves with what was stored; throws with a user-facing message. */
  save: (terms: string[]) => Promise<string[]>;
}

function foldedTerm(term: string) {
  return term.normalize("NFKC").toLocaleLowerCase("und").trim().replace(/\s+/g, " ");
}

/** A term as its chip shows it: masked (or not), without the wildcard `*`, which the chip marks itself. */
export function censorChipLabel(term: string, reveal: boolean) {
  const words = term.trim().split(/\s+/);
  const last = words[words.length - 1] ?? "";
  const wildcard = censorWildcardStem(last) !== null;
  const plain = wildcard ? [...words.slice(0, -1), last.slice(0, -1)].join(" ") : words.join(" ");
  return { text: reveal ? plain : maskCensorTermForDisplay(plain), wildcard };
}

/** What the field holds: one term, or several when pasted with commas or new lines. */
function draftTerms(draft: string) {
  const seen = new Set<string>();
  return draft
    .split(/[,\n;]/)
    .map((term) => term.trim().replace(/\s+/g, " "))
    .filter((term) => {
      const key = foldedTerm(term);
      if (!term || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function termIssue(term: string) {
  return term.length > CENSOR_TERM_MAX_LENGTH
    ? `Keep each word to ${CENSOR_TERM_MAX_LENGTH} characters.`
    : censorTermIssue(term);
}

function SoftButton({
  tone,
  children,
  onClick,
  disabled,
  label,
  pressed,
}: {
  tone: Tone;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  label?: string;
  pressed?: boolean;
}) {
  const t = TONES[tone];
  return (
    <Flex
      as="button"
      aria-label={label}
      aria-pressed={pressed}
      align="center"
      justify="center"
      gap="1.5"
      h="32px"
      px="3"
      flexShrink={0}
      borderRadius="8px"
      bg={t.chip}
      border="none"
      color={t.fg}
      fontSize="13px"
      fontWeight="500"
      whiteSpace="nowrap"
      cursor={disabled ? "not-allowed" : "pointer"}
      opacity={disabled ? 0.45 : 1}
      aria-disabled={disabled}
      transition="background 120ms ease, opacity 120ms ease"
      _hover={disabled ? undefined : { bg: t.chipHover }}
      onClick={disabled ? undefined : onClick}
    >
      {children}
    </Flex>
  );
}

/** A row of soft pills, one selected: the dialog's list tabs and the category filter. */
function Pills<T extends string>({
  tone,
  label,
  value,
  options,
  onChange,
  size = "md",
}: {
  tone: Tone;
  label: string;
  value: T;
  options: readonly { value: T; label: string; count: number }[];
  onChange: (value: T) => void;
  size?: "sm" | "md";
}) {
  const t = TONES[tone];
  return (
    <Flex role="radiogroup" aria-label={label} gap="1" flexWrap="wrap">
      {options.map((option) => {
        const selected = option.value === value;
        return (
          <Flex
            key={option.value}
            as="button"
            role="radio"
            aria-checked={selected}
            align="center"
            gap="1.5"
            h={size === "sm" ? "26px" : "32px"}
            px={size === "sm" ? "2.5" : "3"}
            borderRadius="full"
            border="none"
            bg={selected ? t.accentSoft : "transparent"}
            color={selected ? t.accentFg : t.muted}
            fontSize={size === "sm" ? "12px" : "13px"}
            fontWeight="500"
            cursor="pointer"
            transition="background 140ms ease, color 140ms ease"
            _hover={selected ? undefined : { color: t.fg, bg: t.soft }}
            onClick={() => onChange(option.value)}
          >
            {option.label}
            <Text as="span" fontVariantNumeric="tabular-nums" opacity={0.7}>
              {option.count}
            </Text>
          </Flex>
        );
      })}
    </Flex>
  );
}

/** How full a list is: a hairline meter that fills as words are added. */
function Capacity({ tone, count, max, note }: { tone: Tone; count: number; max: number; note?: string }) {
  const t = TONES[tone];
  const ratio = Math.min(1, count / max);
  return (
    <Stack gap="1.5" minW="0" flex="1">
      <Text fontSize="12px" color={t.subtle} fontVariantNumeric="tabular-nums" whiteSpace="nowrap">
        <Text as="span" color={t.fg} fontWeight="500">{count}</Text> of {max} words
        {note ? ` · ${note}` : null}
      </Text>
      <Box
        h="3px"
        maxW="180px"
        borderRadius="full"
        bg={t.chip}
        overflow="hidden"
        role="meter"
        aria-label="List capacity"
        aria-valuemin={0}
        aria-valuemax={max}
        aria-valuenow={count}
      >
        <Box
          h="full"
          w={`${ratio * 100}%`}
          borderRadius="full"
          bg={ratio >= 0.9 ? t.danger : t.accent}
          transition="width 320ms cubic-bezier(0.2, 0.8, 0.2, 1)"
        />
      </Box>
    </Stack>
  );
}

/**
 * One list entry. Masked by default; hovering or focusing it peeks at the word.
 * A wildcard entry ends in an accent "+" (and longer forms) instead of a
 * trailing `*`, which would read as part of the mask.
 */
function WordChip({
  tone,
  term,
  reveal,
  fresh,
  found,
  onRemove,
  busy,
}: {
  tone: Tone;
  term: string;
  reveal: boolean;
  fresh: boolean;
  found: boolean;
  onRemove: (() => void) | null;
  busy: boolean;
}) {
  const t = TONES[tone];
  const masked = censorChipLabel(term, reveal);
  const plain = censorChipLabel(term, true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (found) ref.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [found]);
  const highlighted = fresh || found;
  return (
    <Flex
      ref={ref}
      data-chip
      align="center"
      gap="1"
      h="30px"
      ps="2.5"
      pe={onRemove ? "1" : "2.5"}
      borderRadius="8px"
      bg={highlighted ? t.accentSoft : t.chip}
      color={highlighted ? t.accentFg : t.fg}
      fontSize="13px"
      fontVariantNumeric="tabular-nums"
      animation={fresh ? "scale-in 220ms cubic-bezier(0.2, 0.8, 0.2, 1)" : undefined}
      transition="background 300ms ease, color 300ms ease"
      title={masked.wildcard ? "Also catches words that start with this" : undefined}
      css={{
        "& [data-peek]": { display: "none" },
        "&:hover [data-peek], &:focus-within [data-peek]": { display: "inline" },
        "&:hover [data-mask], &:focus-within [data-mask]": { display: "none" },
      }}
    >
      {/* Screen readers always get the masked form, as the button label does. */}
      <Text as="span" data-mask>{masked.text}</Text>
      <Text as="span" data-peek aria-hidden>{plain.text}</Text>
      {masked.wildcard ? (
        <Text as="span" color={t.accentFg} fontWeight="600" ms="-0.5" aria-label="and its variants">
          +
        </Text>
      ) : null}
      {onRemove ? (
        <Flex
          as="button"
          aria-label={`Remove ${maskCensorTermForDisplay(term)}`}
          align="center"
          justify="center"
          boxSize="22px"
          ms="0.5"
          borderRadius="6px"
          bg="transparent"
          border="none"
          color={t.muted}
          cursor={busy ? "not-allowed" : "pointer"}
          opacity={busy ? 0.5 : 1}
          transition="background 120ms ease, color 120ms ease"
          _hover={busy ? undefined : { color: t.danger, bg: t.chipHover }}
          onClick={busy ? undefined : onRemove}
        >
          <X size={12} />
        </Flex>
      ) : (
        <Box w="0" />
      )}
    </Flex>
  );
}

type Category = "all" | "profanity" | "slur" | "custom";

/**
 * One editable (or read-only) list: the search-or-add field, the category
 * filter (Workspace list only), and the chips.
 */
function WordListPane({
  tone,
  words,
  max,
  canEdit,
  readOnlyNote,
  placeholder,
  reveal,
  busy,
  fresh,
  showCategories,
  onAdd,
  onRemove,
  empty,
}: {
  tone: Tone;
  words: readonly string[];
  max: number;
  canEdit: boolean;
  readOnlyNote: string;
  placeholder: string;
  reveal: boolean;
  busy: boolean;
  fresh: ReadonlySet<string>;
  showCategories: boolean;
  onAdd: (terms: string[]) => Promise<boolean>;
  onRemove: (term: string) => void;
  empty: ReactNode;
}) {
  const t = TONES[tone];
  const [draft, setDraft] = useState("");
  const [category, setCategory] = useState<Category>("all");

  const terms = draftTerms(draft);
  const existing = useMemo(() => new Set(words.map(foldedTerm)), [words]);
  const duplicates = terms.filter((term) => existing.has(foldedTerm(term)));
  const invalid = terms.map(termIssue).find((issue) => issue !== null) ?? null;
  const adding = terms.filter((term) => !existing.has(foldedTerm(term)) && termIssue(term) === null);
  const room = max - words.length;
  const issue = invalid
    ?? (adding.length > room ? (room === 0 ? `The list is full (${max} words).` : `Only ${room} more ${room === 1 ? "word fits" : "words fit"}.`) : null);
  const canAdd = canEdit && adding.length > 0 && !issue && !busy;
  // A single term already in the list is found, not added: its chip lights up.
  const found = terms.length === 1 && duplicates.length === 1 ? foldedTerm(duplicates[0]!) : null;

  const counts = useMemo(() => {
    const tally = { all: words.length, profanity: 0, slur: 0, custom: 0 };
    for (const word of words) {
      if (!DEFAULT_TERMS.has(foldedTerm(word))) tally.custom += 1;
      else tally[censorWordCategory(word)] += 1;
    }
    return tally;
  }, [words]);

  // Searching filters by the real word, so a masked list stays findable.
  const query = terms.length === 1 ? foldedTerm(terms[0]!).replace(/\*$/, "") : "";
  const visible = words.filter((word) => {
    const key = foldedTerm(word);
    if (category === "custom" && DEFAULT_TERMS.has(key)) return false;
    if ((category === "profanity" || category === "slur") && (!DEFAULT_TERMS.has(key) || censorWordCategory(word) !== category)) {
      return false;
    }
    return !query || key.includes(query) || found === key;
  });

  const submit = async () => {
    if (!canAdd) return;
    // The chips appear at once; the field comes back only if the save fails.
    const typed = draft;
    setDraft("");
    if (!(await onAdd(adding))) setDraft((current) => current || typed);
  };

  const addLabel = adding.length > 1 ? `Add ${adding.length}` : "Add";
  const helper = issue
    ? null
    : found
      ? "Already in the list."
      : duplicates.length > 0 && adding.length > 0
        ? `${duplicates.length} already in the list will be skipped.`
        : canEdit
          ? "Type to search. End a word with * to catch its variants, or paste several separated by commas."
          : "Type to search the list.";

  const categoryOptions = (
    [
      { value: "all", label: "All", count: counts.all },
      { value: "profanity", label: "Profanity", count: counts.profanity },
      { value: "slur", label: "Slurs", count: counts.slur },
      { value: "custom", label: "Added", count: counts.custom },
    ] as const
  ).filter((option) => option.value === "all" || option.count > 0);

  return (
    <Stack gap="3">
      <Stack gap="1.5">
        <Flex gap="2">
          <Box position="relative" flex="1">
            <Box position="absolute" insetStart="3" top="50%" transform="translateY(-50%)" color={t.subtle} pointerEvents="none" zIndex={1}>
              <Search size={15} />
            </Box>
            <Input
              aria-label={placeholder}
              aria-invalid={issue ? true : undefined}
              data-clears-on-escape=""
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  void submit();
                }
                // Escape clears the field first (the dialog stays open, see
                // onEscapeKeyDown); a second Escape closes the dialog.
                if (event.key === "Escape") setDraft("");
              }}
              onPaste={(event) => {
                // A pasted list keeps its separators instead of collapsing onto one line.
                const pasted = event.clipboardData.getData("text");
                if (/[\n;]/.test(pasted)) {
                  event.preventDefault();
                  setDraft((current) => [current, ...pasted.split(/[\n;]/)].map((part) => part.trim()).filter(Boolean).join(", "));
                }
              }}
              placeholder={placeholder}
              h="40px"
              ps="9"
              pe="3"
              fontSize="14px"
              {...(tone === "studio"
                ? {
                    bg: t.soft,
                    borderWidth: "1px",
                    borderColor: "transparent",
                    borderRadius: "10px",
                    color: t.fg,
                    focusVisibleRing: "none" as const,
                    _placeholder: { color: t.subtle },
                    _focus: { ...FIELD_FOCUS, borderColor: "studio.borderFocus" },
                    _focusVisible: { ...FIELD_FOCUS, borderColor: "studio.borderFocus" },
                  }
                : {})}
            />
          </Box>
          {canEdit ? (
            <Flex
              as="button"
              aria-label={adding.length > 1 ? `Add ${adding.length} words` : "Add word"}
              align="center"
              gap="1.5"
              h="40px"
              px="3.5"
              flexShrink={0}
              borderRadius="10px"
              bg={canAdd ? t.accentSoft : t.chip}
              border="none"
              color={canAdd ? t.accentFg : t.fg}
              fontSize="14px"
              fontWeight="500"
              cursor={canAdd ? "pointer" : "not-allowed"}
              opacity={canAdd ? 1 : 0.45}
              aria-disabled={!canAdd}
              transition="background 140ms ease, color 140ms ease, opacity 140ms ease"
              onClick={() => void submit()}
            >
              <Plus size={15} /> {addLabel}
            </Flex>
          ) : null}
        </Flex>
        {issue ? (
          <Text role="alert" fontSize="12px" color={t.danger}>{issue}</Text>
        ) : (
          <Text fontSize="12px" color={found ? t.accentFg : t.subtle} aria-live="polite">{helper}</Text>
        )}
        {!canEdit ? <Text fontSize="12px" color={t.subtle}>{readOnlyNote}</Text> : null}
      </Stack>

      {showCategories && categoryOptions.length > 2 ? (
        <Pills tone={tone} size="sm" label="Filter words" value={category} options={categoryOptions} onChange={setCategory} />
      ) : null}

      {words.length === 0 ? (
        empty
      ) : visible.length === 0 ? (
        <Flex direction="column" align="center" textAlign="center" gap="1" px="4" py="6" bg={t.soft} borderRadius="12px">
          <Text fontSize="13.5px" fontWeight="500">No words match</Text>
          <Text fontSize="12.5px" color={t.muted}>
            {canEdit && adding.length > 0 ? "Press Enter to add it." : "Try another search or filter."}
          </Text>
        </Flex>
      ) : (
        // A long list scrolls inside its own box so the tester below stays in reach.
        <Flex gap="1.5" flexWrap="wrap" maxH="228px" overflowY="auto" alignContent="flex-start" pe="1">
          {visible.map((word) => (
            <WordChip
              key={word}
              tone={tone}
              term={word}
              reveal={reveal}
              fresh={fresh.has(foldedTerm(word))}
              found={found === foldedTerm(word)}
              busy={busy}
              onRemove={canEdit ? () => onRemove(word) : null}
            />
          ))}
        </Flex>
      )}
    </Stack>
  );
}

/**
 * Types a line, shows it as a caption would: each censored word masked and
 * tinted. It runs the same detector the Studio scans clips with.
 */
function CensorTester({
  tone,
  terms,
  locale,
}: {
  tone: Tone;
  terms: { workspace: readonly string[]; project: readonly string[]; brand: readonly string[] };
  locale: string;
}) {
  const t = TONES[tone];
  const [line, setLine] = useState("");
  const { tokens, censored } = useMemo(() => {
    const tokens = line.split(/\s+/).filter(Boolean);
    if (tokens.length === 0) return { tokens, censored: new Set<string>() };
    const suggestions = detectAutoCensorSuggestions({
      documentRevision: 0,
      locale,
      clipWindow: { startSec: 0, endSec: tokens.length + 1 },
      transcript: [{
        index: 0,
        speakerLabel: "A",
        startSec: 0,
        endSec: tokens.length,
        text: line,
        confidence: null,
        words: tokens.map((word, index) => ({ id: `t${index}`, word, startSec: index, endSec: index + 0.5, confidence: null })),
      }],
      workspaceTerms: terms.workspace,
      brandTerms: terms.brand,
      projectTerms: terms.project,
      paddingSec: 0,
    });
    return { tokens, censored: new Set(suggestions.flatMap((suggestion) => suggestion.sourceWordIds)) };
  }, [line, locale, terms]);

  return (
    <Stack gap="2.5" p="4" bg={t.soft} borderRadius="12px">
      <Flex align="center" gap="2">
        <Box color={t.accentFg} aria-hidden><Sparkles size={14} /></Box>
        <Text fontSize="13px" fontWeight="500">Try a line</Text>
        <Text fontSize="12px" color={t.subtle} ms="auto" aria-live="polite" fontVariantNumeric="tabular-nums">
          {tokens.length === 0
            ? "Checks every list here"
            : censored.size === 0
              ? "Nothing would be censored"
              : `${censored.size} ${censored.size === 1 ? "word" : "words"} censored`}
        </Text>
      </Flex>
      <Input
        aria-label="Test a line against the word lists"
        data-clears-on-escape=""
        value={line}
        onChange={(event) => setLine(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Escape") setLine(""); }}
        placeholder="Type or paste a line from a video"
        h="38px"
        px="3"
        fontSize="13.5px"
        {...(tone === "studio"
          ? {
              bg: "studio.canvas",
              borderWidth: "1px",
              borderColor: "transparent",
              borderRadius: "10px",
              color: t.fg,
              focusVisibleRing: "none" as const,
              _placeholder: { color: t.subtle },
              _focus: { ...FIELD_FOCUS, borderColor: "studio.borderFocus" },
              _focusVisible: { ...FIELD_FOCUS, borderColor: "studio.borderFocus" },
            }
          : { bg: "bg.dialog" })}
      />
      {tokens.length > 0 ? (
        <Text fontSize="14px" lineHeight="1.9" color={t.fg} aria-label="How the line would read">
          {tokens.map((word, index) => {
            const hit = censored.has(`t${index}`);
            return (
              <Box as="span" key={`${index}-${word}`}>
                {index > 0 ? " " : null}
                {hit ? (
                  <Box
                    as="span"
                    px="1.5"
                    py="0.5"
                    borderRadius="6px"
                    bg={t.accentSoft}
                    color={t.accentFg}
                    fontWeight="500"
                    animation="scale-in 180ms cubic-bezier(0.2, 0.8, 0.2, 1)"
                  >
                    {maskCensoredCaptionWord(word, { replacement: "first_last", preservePunctuation: true })}
                  </Box>
                ) : (
                  word
                )}
              </Box>
            );
          })}
        </Text>
      ) : null}
    </Stack>
  );
}

type ListTab = "workspace" | "project" | "brand";

export function CensorWordListDialog({
  open,
  onOpenChange,
  tone,
  workspace,
  project,
  onProjectTermsChange,
  brandTerms = [],
  locale = "en",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  tone: Tone;
  workspace: WorkspaceCensorWordsEditor;
  project?: ProjectCensorTerms;
  onProjectTermsChange?: (terms: string[]) => void;
  brandTerms?: readonly string[];
  /** The clip's transcript language, for the tester. */
  locale?: string;
}) {
  const t = TONES[tone];
  const { canEdit: canEditWorkspace, customized } = workspace;
  const [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<ListTab>("workspace");
  // Shown at once while a save runs; dropped when it lands or fails.
  const [workspaceDraft, setWorkspaceDraft] = useState<readonly string[] | null>(null);
  const [projectDraft, setProjectDraft] = useState<readonly string[] | null>(null);
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set());
  const workspaceWords = workspaceDraft ?? workspace.words;
  const projectTerms = projectDraft ?? project?.terms ?? [];
  // The latest lists, for an Undo pressed after later edits.
  const latest = useRef({ workspaceWords, projectTerms });
  latest.current = { workspaceWords, projectTerms };

  // Words stay hidden, and the Workspace list leads, each time the dialog opens.
  useEffect(() => {
    if (open) {
      setReveal(false);
      setTab("workspace");
    }
  }, [open]);

  useEffect(() => {
    if (fresh.size === 0) return;
    const timer = window.setTimeout(() => setFresh(new Set()), 1600);
    return () => window.clearTimeout(timer);
  }, [fresh]);

  const fail = (title: string, description: string) =>
    toaster.create({ type: "error", title, description });

  async function saveWorkspace(
    run: () => Promise<unknown>,
    optimistic: readonly string[] | null,
  ): Promise<boolean> {
    setBusy(true);
    setWorkspaceDraft(optimistic);
    try {
      const result = await run();
      const saved = result as { words?: unknown; customized?: unknown } | null;
      if (
        !saved ||
        typeof saved !== "object" ||
        !Array.isArray(saved.words) ||
        typeof saved.customized !== "boolean"
      ) {
        fail("Word list not saved", UNCHANGED);
        return false;
      }
      workspace.onChange({ words: saved.words as string[], customized: saved.customized });
      return true;
    } catch (error) {
      const message = apiErrorMessage(error, UNCHANGED);
      if (message !== null) fail("Word list not saved", message);
      return false;
    } finally {
      setWorkspaceDraft(null);
      setBusy(false);
    }
  }

  async function saveProject(next: string[]): Promise<boolean> {
    if (!project) return false;
    setBusy(true);
    setProjectDraft(next);
    try {
      onProjectTermsChange?.(await project.save(next));
      return true;
    } catch (error) {
      fail("Project words not saved", error instanceof Error ? error.message : UNCHANGED);
      return false;
    } finally {
      setProjectDraft(null);
      setBusy(false);
    }
  }

  const saveWorkspaceList = (next: string[]) => saveWorkspace(() => workspace.save(next), next);

  async function add(list: ListTab, terms: string[]) {
    const current = list === "workspace" ? latest.current.workspaceWords : latest.current.projectTerms;
    // Newest first, so what was just added is in view.
    const next = [...terms, ...current];
    setFresh(new Set(terms.map(foldedTerm)));
    return list === "workspace" ? saveWorkspaceList(next) : saveProject(next);
  }

  async function remove(list: ListTab, term: string) {
    const current = list === "workspace" ? latest.current.workspaceWords : latest.current.projectTerms;
    const next = current.filter((candidate) => candidate !== term);
    const saved = list === "workspace" ? await saveWorkspaceList(next) : await saveProject(next);
    if (!saved) return;
    const label = censorChipLabel(term, false);
    toaster.create({
      type: "info",
      duration: 8000,
      title: `Removed ${label.text}${label.wildcard ? "+" : ""}`,
      description: list === "workspace" ? "From the workspace list." : "From this project's list.",
      action: {
        label: "Undo",
        onClick: () => void add(list, [term]),
      },
    });
  }

  const revealToggle = (
    <SoftButton tone={tone} pressed={reveal} onClick={() => setReveal((current) => !current)}>
      {reveal ? <EyeOff size={14} /> : <Eye size={14} />}
      {reveal ? "Hide words" : "Show words"}
    </SoftButton>
  );

  const listEmpty = (title: string, body: string) => (
    <Flex direction="column" align="center" textAlign="center" gap="1.5" px="4" py="6" bg={t.soft} borderRadius="12px">
      <Box color={t.subtle} aria-hidden><ShieldCheck size={20} /></Box>
      <Text fontSize="14px" fontWeight="500">{title}</Text>
      <Text fontSize="12.5px" color={t.muted} maxW="300px" lineHeight="1.5">{body}</Text>
    </Flex>
  );

  const testerTerms = useMemo(
    () => ({ workspace: workspaceWords, project: projectTerms, brand: brandTerms }),
    [workspaceWords, projectTerms, brandTerms],
  );

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(event) => onOpenChange(event.open)}
      // Escape in a field with text only clears it. The dialog hears Escape
      // first (a capture listener), while the field still holds its text.
      onEscapeKeyDown={(event) => {
        const active = document.activeElement;
        if (active instanceof HTMLInputElement && active.hasAttribute("data-clears-on-escape") && active.value) {
          event.preventDefault();
        }
      }}
      // A toast's Undo sits outside the dialog; pressing it must not close the list.
      persistentElements={[() => document.querySelector('[data-scope="toast"][data-part="group"]')]}
      placement="center"
      scrollBehavior="inside"
    >
      <Portal>
        <Dialog.Backdrop zIndex={300} />
        <Dialog.Positioner zIndex={310}>
          <Dialog.Content
            w="min(580px, 94vw)"
            maxW="min(580px, 94vw)"
            maxH="min(760px, 92vh)"
            bg={t.surface}
            color={t.fg}
            borderRadius="14px"
          >
            <Flex px="6" pt="5" pb="3" align="flex-start" justify="space-between" gap="3">
              <Stack gap="1">
                <Dialog.Title asChild>
                  <Text fontSize="18px" fontWeight="500" letterSpacing="-0.01em">Censored words</Text>
                </Dialog.Title>
                <Dialog.Description asChild>
                  <Text fontSize="13px" color={t.muted} lineHeight="1.5">
                    Auto-censor masks and beeps these in every clip. Words show masked; hover one to peek.
                  </Text>
                </Dialog.Description>
              </Stack>
              <Dialog.CloseTrigger asChild>
                <Flex
                  as="button"
                  aria-label="Close"
                  align="center"
                  justify="center"
                  boxSize="32px"
                  flexShrink={0}
                  borderRadius="full"
                  bg="transparent"
                  border="none"
                  color={t.muted}
                  cursor="pointer"
                  position="static"
                  _hover={{ color: t.fg, bg: t.chip }}
                >
                  <X size={17} />
                </Flex>
              </Dialog.CloseTrigger>
            </Flex>

            <Dialog.Body px="6" pb="6" pt="1">
              <Stack gap="4">
                {project ? (
                  <Pills
                    tone={tone}
                    label="Word lists"
                    value={tab}
                    onChange={setTab}
                    options={[
                      { value: "workspace", label: "Workspace", count: workspaceWords.length },
                      { value: "project", label: "This project", count: projectTerms.length },
                      { value: "brand", label: "Brand", count: brandTerms.length },
                    ]}
                  />
                ) : null}

                <Flex align="center" justify="space-between" gap="3" minH="34px">
                  {tab === "brand" ? (
                    <Text fontSize="12px" color={t.subtle}>Blocked words from this project's brand voice.</Text>
                  ) : (
                    <Capacity
                      tone={tone}
                      count={tab === "workspace" ? workspaceWords.length : projectTerms.length}
                      max={tab === "workspace" ? WORKSPACE_CENSOR_WORDS_MAX : PROJECT_CENSOR_TERMS_MAX}
                      note={busy ? "Saving…" : tab === "workspace" ? (customized ? "Edited" : "Default list") : "This project only"}
                    />
                  )}
                  <Flex gap="2" flexShrink={0}>
                    {tab === "workspace" && canEditWorkspace ? (
                      <SoftButton
                        tone={tone}
                        disabled={!customized || busy}
                        onClick={() => void saveWorkspace(() => workspace.reset(), DEFAULT_CENSOR_WORD_LIST)}
                      >
                        <RotateCcw size={13} /> Reset
                      </SoftButton>
                    ) : null}
                    {tab === "brand" ? (
                      <Box
                        as="a"
                        // Opens beside the editor so unsaved work stays put.
                        {...{ href: "/brand-kit", target: "_blank", rel: "noreferrer" }}
                        display="inline-flex"
                        alignItems="center"
                        h="32px"
                        px="3"
                        borderRadius="8px"
                        bg={t.chip}
                        fontSize="13px"
                        fontWeight="500"
                        color={t.fg}
                        _hover={{ bg: t.chipHover }}
                      >
                        Edit in Brand kit
                      </Box>
                    ) : null}
                    {revealToggle}
                  </Flex>
                </Flex>

                {tab === "workspace" ? (
                  <WordListPane
                    key="workspace"
                    tone={tone}
                    words={workspaceWords}
                    max={WORKSPACE_CENSOR_WORDS_MAX}
                    canEdit={canEditWorkspace}
                    readOnlyNote="Shared by every project here. Only owners and admins can change this list."
                    placeholder={canEditWorkspace ? "Search or add a word" : "Search the list"}
                    reveal={reveal}
                    busy={busy}
                    fresh={fresh}
                    showCategories
                    onAdd={(terms) => add("workspace", terms)}
                    onRemove={(term) => void remove("workspace", term)}
                    empty={listEmpty(
                      "The list is empty",
                      `Nothing is censored from the workspace list.${canEditWorkspace ? " Add a word, or reset to the defaults." : ""}`,
                    )}
                  />
                ) : null}

                {tab === "project" && project ? (
                  <WordListPane
                    key="project"
                    tone={tone}
                    words={projectTerms}
                    max={PROJECT_CENSOR_TERMS_MAX}
                    canEdit={project.canEdit}
                    readOnlyNote="Only editors of this project can change its words."
                    placeholder="Search or add a word for this project"
                    reveal={reveal}
                    busy={busy}
                    fresh={fresh}
                    showCategories={false}
                    onAdd={(terms) => add("project", terms)}
                    onRemove={(term) => void remove("project", term)}
                    empty={listEmpty(
                      "No project words yet",
                      "Names, brands or topics to censor in this project only, on top of the workspace list.",
                    )}
                  />
                ) : null}

                {tab === "brand" ? (
                  brandTerms.length === 0 ? (
                    listEmpty("No brand words", "Add blocked words in Brand kit under voice guidance.")
                  ) : (
                    <Flex gap="1.5" flexWrap="wrap" maxH="228px" overflowY="auto" alignContent="flex-start">
                      {brandTerms.map((term) => (
                        <WordChip
                          key={term}
                          tone={tone}
                          term={term}
                          reveal={reveal}
                          fresh={false}
                          found={false}
                          busy={busy}
                          onRemove={null}
                        />
                      ))}
                    </Flex>
                  )
                ) : null}

                <CensorTester tone={tone} terms={testerTerms} locale={locale} />
              </Stack>
            </Dialog.Body>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
