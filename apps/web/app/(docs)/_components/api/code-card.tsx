"use client";

import { type ReactNode, useEffect, useState } from "react";
import { Box, type BoxProps, chakra, Flex, type FlexProps, IconButton, Text } from "@chakra-ui/react";
import { Check, Copy } from "lucide-react";
import { copyToClipboard } from "@narriflow/ui/components/code-block";
import { SHIKI_STYLES } from "./code-theme";

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [status, setStatus] = useState<"idle" | "copied" | "error">("idle");
  useEffect(() => {
    if (status === "idle") return;
    const timer = setTimeout(() => setStatus("idle"), 1800);
    return () => clearTimeout(timer);
  }, [status]);

  return (
    <>
      <IconButton
        type="button"
        variant="ghost"
        size="xs"
        color={status === "copied" ? "accent.fg" : "fg.muted"}
        aria-label={status === "copied" ? "Copied" : status === "error" ? "Copy failed" : label}
        title={label}
        onClick={async () => setStatus((await copyToClipboard(text)) ? "copied" : "error")}
      >
        {status === "copied" ? <Check size={14} /> : <Copy size={14} />}
      </IconButton>
      <Text srOnly aria-live="polite">
        {status === "copied" ? "Copied to clipboard" : status === "error" ? "Could not copy to clipboard" : ""}
      </Text>
    </>
  );
}

/**
 * The in-app code block's look for the example cards: soft fill, 12px radius,
 * a header row (a menu or tabs on the left, copy on the right) above the code.
 */
export function CodeCard({ start, copy, children, ...rest }: { start: ReactNode; copy: { text: string; label: string }; children: ReactNode } & FlexProps) {
  return (
    <Flex direction="column" minH="0" minW="0" bg="bg.soft" borderRadius="12px" overflow="hidden" {...rest}>
      <Flex h="10" flexShrink={0} ps="2" pe="2" align="center" justify="space-between" gap="2">
        {start}
        <CopyButton text={copy.text} label={copy.label} />
      </Flex>
      {children}
    </Flex>
  );
}

/** Inline cards cap their code; in the sticky column (xl) the card itself shrinks to fit instead. */
const DEFAULT_PANE_MAX_H = { base: "24rem", xl: "none" };

/** The scrolling code area of a card; Shiki's tokens take their colours from the mode. */
export function CodePane({ children, maxH = DEFAULT_PANE_MAX_H }: { children: ReactNode; maxH?: BoxProps["maxH"] }) {
  return (
    <Box
      flex="1"
      minH="0"
      maxH={maxH}
      px="4"
      pt="1"
      pb="3"
      overflow="auto"
      fontFamily="mono"
      fontSize="12.5px"
      lineHeight="1.7"
      color="fg"
      whiteSpace="pre"
      css={{ scrollbarWidth: "thin", ...SHIKI_STYLES }}
    >
      {children}
    </Box>
  );
}

export interface Tab {
  value: string;
  label: string;
}

/** Header tabs in the code block's style: the current one is underlined in ink. */
export function CodeTabs({ label, tabs, value, onChange, mono }: { label: string; tabs: Tab[]; value: string; onChange: (value: string) => void; mono?: boolean }) {
  return (
    <Flex role="tablist" aria-label={label} gap="0.5" h="full" minW="0" overflowX="auto" css={{ scrollbarWidth: "none" }}>
      {tabs.map((tab) => {
        const active = tab.value === value;
        return (
          <chakra.button
            key={tab.value}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(tab.value)}
            px="1.5"
            h="full"
            flexShrink={0}
            fontSize="12.5px"
            fontWeight="500"
            fontFamily={mono ? "mono" : undefined}
            color={active ? "fg" : "fg.muted"}
            boxShadow={active ? "inset 0 -1.5px 0 var(--chakra-colors-fg)" : "none"}
            _hover={{ color: "fg" }}
            cursor="pointer"
          >
            {tab.label}
          </chakra.button>
        );
      })}
    </Flex>
  );
}
