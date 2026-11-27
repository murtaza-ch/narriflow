"use client";

import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { Box, Flex, Text, chakra } from "@chakra-ui/react";
import { Apple, Clock, Hand, Lamp, MessageCircle, PawPrint, Plane, Search, Shapes, Smile, Trophy, Users, X } from "lucide-react";
import {
  CAPTION_EMOJI_COUNT,
  CAPTION_EMOJI_GROUPS,
  CAPTION_EMOJI_INDEX,
  captionEmojiById,
  emojiRefForGlyph,
  type CaptionEmojiEntry,
} from "@narriflow/caption-emoji/index";
import { EmojiArtSvg, EmojiGlyphSpace } from "./emoji-glyph";
import { COLUMNS, EmojiPickerGrid, HEADER, ROW } from "./emoji-picker-parts";
import { SkinTones } from "./emoji-skin-tones";
import type { EmojiPickerRequest } from "./emoji-picker-host";
import {
  buildEmojiSearch,
  captionEmojiPickerGroups,
  captionEmojiQueryTone,
  moveInGrid,
  pickedEmojiRef,
  pickerLayout,
  pickerStartTone,
  readRecentEmojis,
  searchCaptionEmojis,
  visibleRows,
  withRecentEmoji,
  writeRecentEmojis,
  type GridMove,
  type PickerSection,
} from "./emoji-picker-model";
import { preloadCaptionEmojiArt, useCaptionEmojiArt } from "./use-caption-emoji-art";

// The emoji picker (lazy chunk): search, group jumps, recents, skin tone and a virtual grid of every
// design (each in the six tones through the tone choice) drawn from Narriflow's art in the clip's palette. Focus stays in the search field;
// the arrow keys move the active cell (aria-activedescendant), Enter picks, Escape closes.

const VIEWPORT = 264;
const OVERSCAN = 2 * ROW;

const GROUP_ICONS: Record<string, ReactNode> = {
  recent: <Clock size={15} />,
  smileys: <Smile size={15} />,
  people: <Users size={15} />,
  hands: <Hand size={15} />,
  "animals-and-nature": <PawPrint size={15} />,
  "food-and-drink": <Apple size={15} />,
  activities: <Trophy size={15} />,
  "travel-and-places": <Plane size={15} />,
  objects: <Lamp size={15} />,
  symbols: <Shapes size={15} />,
  phrases: <MessageCircle size={15} />,
};

// Built once per page, on the picker's first open.
let search: ReturnType<typeof buildEmojiSearch> | null = null;
const emojiSearch = () => (search ??= buildEmojiSearch(CAPTION_EMOJI_INDEX, CAPTION_EMOJI_GROUPS));

const GROUP_SECTIONS = captionEmojiPickerGroups(CAPTION_EMOJI_INDEX, CAPTION_EMOJI_GROUPS);
const GROUP_TABS = GROUP_SECTIONS.map((section) => ({ id: section.id, name: section.label }));
/** "Search 2,317 emojis": every emoji, each skin tone counted, so nobody wonders whether some are missing. */
const SEARCH_PLACEHOLDER = `Search ${CAPTION_EMOJI_COUNT.toLocaleString("en-US")} emojis or paste one`;

/** The art of the picker's first screen (the first group's opening rows), fetched before the first open. */
export function preloadEmojiPickerArt(): Promise<void> {
  return preloadCaptionEmojiArt(GROUP_SECTIONS[0]!.items.slice(0, COLUMNS * 8).map((entry) => entry.id));
}

export function EmojiPicker({ request, onClose }: { request: EmojiPickerRequest; onClose: (restoreFocus: boolean) => void }) {
  const baseId = useId();
  const [query, setQuery] = useState("");
  const [tone, setTone] = useState(() => pickerStartTone(request.current, request.palette.tone));
  const [recents, setRecents] = useState(readRecentEmojis);
  const [active, setActive] = useState(0);
  const [scrollTop, setScrollTop] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => inputRef.current?.focus({ preventScroll: true }), []);

  const sections = useMemo((): PickerSection[] => {
    if (query.trim() !== "") return [{ id: "results", label: "Results", items: searchCaptionEmojis(emojiSearch(), query, emojiRefForGlyph) }];
    const recent = recents.flatMap((id) => captionEmojiById(id) ?? []);
    return [{ id: "recent", label: "Recent", items: recent }, ...GROUP_SECTIONS];
  }, [query, recents]);
  const layout = useMemo(() => pickerLayout(sections, COLUMNS, { header: HEADER, row: ROW }), [sections]);

  // A new query starts at the top with its best match active, so typing then Enter picks it.
  const runQuery = (next: string) => {
    setQuery(next);
    // A tone in the query ("dark skin tone", or a pasted 👋🏿) becomes the picker's tone.
    const named = captionEmojiQueryTone(next, emojiRefForGlyph);
    if (named !== null) setTone(named);
    setActive(0);
    setScrollTop(0);
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  };

  const [first, end] = visibleRows(layout, scrollTop, VIEWPORT, OVERSCAN);
  const rows = useMemo(() => layout.rows.slice(first, end), [layout, first, end]);
  const activeEntry = layout.items[active] ?? null;
  const ids = useMemo(() => {
    const visible = rows.flatMap((row) => (row.kind === "cells" ? row.items.map((item) => item.id) : []));
    if (request.current) visible.push(request.current.id);
    if (activeEntry) visible.push(activeEntry.id);
    return visible;
  }, [rows, request.current, activeEntry]);
  const { art } = useCaptionEmojiArt(ids);

  const activeSection = useMemo(() => {
    let current: string | null = null;
    for (const [section, top] of layout.sectionTops) if (top <= scrollTop + 4) current = section;
    return current;
  }, [layout, scrollTop]);

  const pick = (entry: CaptionEmojiEntry) => {
    const next = withRecentEmoji(recents, entry.id);
    writeRecentEmojis(next);
    setRecents(next);
    request.onPick(pickedEmojiRef(entry, tone));
    onClose(true);
  };

  const reveal = (index: number) => {
    const row = layout.rows[layout.rowOf[index] ?? -1];
    const element = scrollRef.current;
    if (!row || !element) return;
    // The grid can be shorter than VIEWPORT when the window is (the popover caps its height).
    const viewport = element.clientHeight || VIEWPORT;
    if (row.top < element.scrollTop) element.scrollTop = row.top;
    else if (row.top + row.height > element.scrollTop + viewport) element.scrollTop = row.top + row.height - viewport;
    setScrollTop(element.scrollTop);
  };

  const move = (to: GridMove) => {
    const next = moveInGrid(layout, active, to);
    if (next < 0) return;
    setActive(next);
    reveal(next);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    const input = event.currentTarget;
    const atEnd = input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
    const moves: Record<string, GridMove | undefined> = { ArrowDown: "down", ArrowUp: "up", ArrowLeft: atEnd && input.value === "" ? "left" : undefined, ArrowRight: atEnd ? "right" : undefined };
    const to = moves[event.key];
    if (to) {
      event.preventDefault();
      move(to);
    } else if (event.key === "Enter" && activeEntry) {
      event.preventDefault();
      pick(activeEntry);
    }
  };

  const jump = (section: string) => {
    const top = layout.sectionTops.get(section);
    if (top === undefined || !scrollRef.current) return;
    scrollRef.current.scrollTop = top;
    setScrollTop(top);
    const firstCell = layout.rows.find((row) => row.kind === "cells" && row.section === section);
    if (firstCell?.kind === "cells") setActive(firstCell.first);
    inputRef.current?.focus({ preventScroll: true });
  };

  const gridId = `${baseId}-grid`;
  const cellId = (index: number) => `${baseId}-cell-${index}`;
  const noResults = query.trim() !== "" && layout.items.length === 0;
  const activeTone = activeEntry?.hasTones ? tone : 0;

  return (
    <Flex direction="column" dir="ltr" flex="1" minH="0">
      <Flex align="center" justify="space-between" gap="3" px="3.5" pt="3" pb="2">
        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" truncate>
          {request.label}
        </Text>
        {request.onRemove ? (
          <Box
            as="button"
            flexShrink={0}
            h="26px"
            px="2.5"
            borderRadius="8px"
            bg="studio.raised"
            color="studio.fg"
            fontSize="12px"
            fontWeight="500"
            cursor="pointer"
            _hover={{ bg: "studio.borderStrong" }}
            onClick={() => {
              request.onRemove?.();
              onClose(true);
            }}
          >
            Remove
          </Box>
        ) : null}
      </Flex>

      {request.move ? (
        <Flex px="3" pb="2" gap="4px" wrap="wrap" role="group" aria-label="Move to another word">
          {request.move.words.map((choice) => (
            <Box
              key={choice.word}
              as="button"
              tabIndex={choice.current ? -1 : undefined}
              aria-pressed={choice.current}
              aria-label={choice.current ? `On “${choice.text}”` : `Move to “${choice.text}”`}
              title={choice.current ? undefined : "Move here"}
              maxW="120px"
              h="24px"
              px="2"
              borderRadius="7px"
              bg={choice.current ? "studio.accentSubtle" : "studio.subtle"}
              color={choice.current ? "studio.accentFg" : "studio.fgMuted"}
              fontSize="12px"
              fontWeight="500"
              truncate
              cursor={choice.current ? "default" : "pointer"}
              transition="background 120ms ease, color 120ms ease"
              _hover={choice.current ? undefined : { bg: "studio.raised", color: "studio.fg" }}
              onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
              onClick={
                choice.current
                  ? undefined
                  : () => {
                      request.move?.onMove(choice.word);
                      onClose(true);
                    }
              }
            >
              {choice.text}
            </Box>
          ))}
        </Flex>
      ) : null}

      <Box px="3">
        <Flex align="center" gap="2" h="36px" px="2.5" bg="studio.subtle" borderRadius="10px" color="studio.fgMuted" transition="background 120ms ease" _focusWithin={{ bg: "studio.raised" }}>
          <Search size={15} aria-hidden />
          <chakra.input
            ref={inputRef}
            flex="1"
            minW="0"
            h="full"
            bg="transparent"
            border="none"
            outline="none"
            color="studio.fg"
            fontSize="13px"
            css={{ "&::placeholder": { color: "var(--chakra-colors-studio-fg-subtle)" } }}
            placeholder={SEARCH_PLACEHOLDER}
            aria-label="Search emojis"
            role="combobox"
            aria-expanded
            aria-controls={gridId}
            aria-autocomplete="list"
            aria-activedescendant={activeEntry ? cellId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => runQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {query ? (
            <Flex
              as="button"
              aria-label="Clear search"
              boxSize="24px"
              align="center"
              justify="center"
              borderRadius="6px"
              color="studio.fgMuted"
              cursor="pointer"
              _hover={{ bg: "studio.borderStrong", color: "studio.fg" }}
              onClick={() => {
                runQuery("");
                inputRef.current?.focus();
              }}
            >
              <X size={14} />
            </Flex>
          ) : null}
        </Flex>
      </Box>

      {query.trim() === "" ? (
        <Flex px="2.5" pt="2" gap="0" justify="space-between" role="group" aria-label="Emoji groups">
          {[{ id: "recent", name: "Recent" }, ...GROUP_TABS].map((group) => {
            const disabled = !layout.sectionTops.has(group.id);
            const current = activeSection === group.id;
            return (
              <Flex
                key={group.id}
                as="button"
                tabIndex={-1}
                aria-label={`Jump to ${group.name}`}
                aria-pressed={current}
                title={group.name}
                boxSize="28px"
                align="center"
                justify="center"
                borderRadius="8px"
                bg={current ? "studio.accentSubtle" : "transparent"}
                color={current ? "studio.accentFg" : "studio.fgMuted"}
                opacity={disabled ? 0.35 : 1}
                cursor={disabled ? "default" : "pointer"}
                transition="background 120ms ease, color 120ms ease"
                _hover={disabled || current ? undefined : { bg: "studio.raised", color: "studio.fg" }}
                onMouseDown={(event: React.MouseEvent) => event.preventDefault()}
                onClick={disabled ? undefined : () => jump(group.id)}
              >
                {GROUP_ICONS[group.id]}
              </Flex>
            );
          })}
        </Flex>
      ) : null}

      <Box
        ref={scrollRef}
        mt="1.5"
        // Fills the picker's fixed height (`EMOJI_PICKER_HEIGHT`), so the footer stays put while results change.
        flex={`1 1 ${VIEWPORT}px`}
        minH={`${ROW * 2}px`}
        overflowY="auto"
        overflowX="hidden"
        px="2.5"
        onScroll={(event: React.UIEvent<HTMLDivElement>) => setScrollTop(event.currentTarget.scrollTop)}
        css={{
          "&::-webkit-scrollbar": { width: "4px" },
          "&::-webkit-scrollbar-thumb": { background: "var(--chakra-colors-studio-raised)", borderRadius: "4px" },
        }}
      >
        {noResults ? (
          <Flex direction="column" align="center" justify="center" textAlign="center" h="full" gap="1" px="6">
            <Text fontSize="13px" fontWeight="500" color="studio.fg">
              No emojis match “{query.trim()}”
            </Text>
            <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.5">
              Try a feeling, a thing, or a word from the caption.
            </Text>
          </Flex>
        ) : (
          <EmojiPickerGrid
            gridId={gridId}
            cellId={cellId}
            layout={layout}
            rows={rows}
            first={first}
            active={active}
            currentId={request.current?.id ?? null}
            art={art}
            palette={request.palette}
            tone={tone}
            onActive={setActive}
            onPick={(index) => {
              const entry = layout.items[index];
              if (entry) pick(entry);
            }}
          />
        )}
      </Box>

      <Flex align="center" justify="space-between" gap="3" px="3.5" py="2.5" bg="studio.subtle">
        <Flex align="center" gap="2" minW="0" aria-live="polite">
          {activeEntry ? (
            <>
              {art.get(activeEntry.id) ? <EmojiArtSvg art={art.get(activeEntry.id)!} palette={request.palette} tone={activeTone} size={22} /> : <EmojiGlyphSpace size={22} />}
              <Text fontSize="12px" color="studio.fg" truncate>
                {activeEntry.name}
              </Text>
            </>
          ) : null}
        </Flex>
        <SkinTones tone={tone} onTone={setTone} />
      </Flex>
    </Flex>
  );
}
