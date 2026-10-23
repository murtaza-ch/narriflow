"use client";

import { type KeyboardEvent, type ReactNode, useRef, useState, useSyncExternalStore } from "react";
import { Box, chakra, Flex, Text } from "@chakra-ui/react";
import { ChevronDown } from "lucide-react";
import { CopyButton } from "@narriflow/ui/components/code-block";

export interface CodePane {
  /** A tab label in a group, or the title of a single block. Untitled single blocks have none. */
  label?: string;
  icon?: ReactNode;
  code: string;
  lineCount: number;
  expandable: boolean;
  nocopy: boolean;
  /** The highlighted `<pre>`. */
  body: ReactNode;
}

// Every code group on the page follows one language choice, remembered across visits.
const STORAGE_KEY = "narriflow-docs-code";
const listeners = new Set<() => void>();
let chosen: string | undefined;

function readChoice(): string {
  if (chosen === undefined) {
    try {
      chosen = localStorage.getItem(STORAGE_KEY) ?? "";
    } catch {
      chosen = "";
    }
  }
  return chosen;
}

function choose(label: string) {
  chosen = label;
  try {
    localStorage.setItem(STORAGE_KEY, label);
  } catch {}
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => void listeners.delete(listener);
}

// The pane's line height in px (12.5px at 1.7): an expandable block collapses to about nine lines.
const COLLAPSED_HEIGHT = 190;
const LINE_HEIGHT = 21.25;

/**
 * The kit CodeBlock's look for highlighted code: soft fill, a header row with
 * the title or tabs, and a copy button. A group shares one header and copies
 * the snippet in view.
 */
export function CodeFrame({ panes, grouped = false }: { panes: CodePane[]; grouped?: boolean }) {
  const choice = useSyncExternalStore(subscribe, readChoice, () => "");
  const tabs = useRef<Array<HTMLButtonElement | null>>([]);
  const [expanded, setExpanded] = useState(false);

  const found = grouped ? panes.findIndex((pane) => pane.label === choice) : -1;
  const index = Math.max(0, found);
  const pane = panes[index];
  if (!pane) return null;

  const tabbed = grouped && panes.length > 1;
  const hasHeader = tabbed || Boolean(pane.label);
  const collapsible = pane.expandable && pane.lineCount * LINE_HEIGHT + 16 > COLLAPSED_HEIGHT;
  const copy = pane.nocopy ? null : <CopyButton value={pane.code} label="Copy" />;

  function onKeyDown(event: KeyboardEvent) {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = (index + step + panes.length) % panes.length;
    const label = panes[next]?.label;
    if (label) choose(label);
    tabs.current[next]?.focus();
  }

  const body = (
    <Box
      flex="1"
      minW="0"
      pt={hasHeader ? "1" : "3"}
      pb="3"
      overflow="hidden"
      maxH={collapsible && !expanded ? `${COLLAPSED_HEIGHT}px` : undefined}
    >
      {panes.map((item, i) => (
        <Box key={item.label ?? i} role={tabbed ? "tabpanel" : undefined} hidden={i !== index}>
          {item.body}
        </Box>
      ))}
    </Box>
  );

  return (
    <Box bg="bg.soft" borderRadius="12px" overflow="hidden" minW="0" my="4">
      {hasHeader ? (
        <>
          <Flex h="10" ps="2" pe="2" align="center" justify="space-between" gap="2">
            {tabbed ? (
              <Flex role="tablist" aria-label="Code examples" gap="1" h="full" minW="0" overflowX="auto" css={{ scrollbarWidth: "none" }}>
                {panes.map((item, i) => (
                  <chakra.button
                    key={item.label}
                    ref={(node: HTMLButtonElement | null) => {
                      tabs.current[i] = node;
                    }}
                    type="button"
                    role="tab"
                    aria-selected={i === index}
                    tabIndex={i === index ? 0 : -1}
                    onClick={() => item.label && choose(item.label)}
                    onKeyDown={onKeyDown}
                    display="flex"
                    alignItems="center"
                    gap="1.5"
                    px="2"
                    h="full"
                    flexShrink={0}
                    fontSize="12.5px"
                    fontWeight="500"
                    whiteSpace="nowrap"
                    color={i === index ? "fg" : "fg.muted"}
                    boxShadow={i === index ? "inset 0 -1.5px 0 var(--chakra-colors-fg)" : "none"}
                    _hover={{ color: "fg" }}
                    cursor="pointer"
                  >
                    {item.icon}
                    {item.label}
                  </chakra.button>
                ))}
              </Flex>
            ) : (
              <Flex align="center" gap="1.5" px="2" minW="0" fontSize="12.5px" fontWeight="500" color="fg.muted">
                {pane.icon}
                <Text as="span" truncate>
                  {pane.label}
                </Text>
              </Flex>
            )}
            {copy}
          </Flex>
          {body}
        </>
      ) : (
        <Flex align="flex-start" pe="1.5">
          {body}
          <Box pt="1.5">{copy}</Box>
        </Flex>
      )}
      {collapsible ? (
        <chakra.button
          type="button"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
          display="flex"
          alignItems="center"
          gap="1.5"
          w="full"
          px="4"
          py="2"
          fontSize="12.5px"
          fontWeight="500"
          color="fg.muted"
          cursor="pointer"
          _hover={{ color: "fg" }}
        >
          <ChevronDown size={14} style={{ transform: expanded ? "rotate(180deg)" : undefined }} aria-hidden="true" />
          {expanded ? "Collapse" : `See all ${pane.lineCount} lines`}
        </chakra.button>
      ) : null}
    </Box>
  );
}
