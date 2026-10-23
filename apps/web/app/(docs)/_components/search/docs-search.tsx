"use client";

import { useEffect, useId, useState } from "react";
import { chakra, Text } from "@chakra-ui/react";
import { Search } from "lucide-react";
import { SearchDialog } from "./search-dialog";
import { setSearchOpen, useSearchTrigger } from "./search-store";

function isTyping(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
}

/** The one dialog, opened by ⌘K, Ctrl+K or "/" outside a field. */
function SearchHost({ open }: { open: boolean }) {
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const chord = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      const slash = event.key === "/" && !event.metaKey && !event.ctrlKey && !event.altKey && !isTyping(event.target);
      if (!chord && !slash) return;
      event.preventDefault();
      setSearchOpen(true);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return <SearchDialog open={open} onOpenChange={setSearchOpen} />;
}

function ShortcutHint() {
  const [apple, setApple] = useState(true);
  useEffect(() => setApple(/Mac|iPhone|iPad|iPod/.test(navigator.userAgent)), []);
  return (
    <Text as="kbd" fontSize="11px" color="fg.subtle" bg="bg.soft" borderRadius="4px" px="1" fontFamily="inherit">
      {apple ? "⌘K" : "Ctrl K"}
    </Text>
  );
}

/**
 * The search trigger: a full-width field for the sidebar, or a bare icon
 * (`compact`) for the mobile bar. Mount as many as the layout needs; the
 * first one mounted renders the dialog and listens for the shortcuts.
 */
export function DocsSearchButton({ variant = "field" }: { variant?: "field" | "compact" }) {
  const { host, open } = useSearchTrigger(useId());
  const compact = variant === "compact";
  return (
    <>
      <chakra.button
        type="button"
        aria-label="Search docs"
        aria-haspopup="dialog"
        aria-keyshortcuts="Meta+K Control+K"
        onClick={() => setSearchOpen(true)}
        display="flex"
        alignItems="center"
        justifyContent={compact ? "center" : undefined}
        gap="2"
        h={compact ? "8" : "9"}
        w={compact ? "8" : "full"}
        px={compact ? "0" : "3"}
        borderRadius={compact ? "l2" : "control"}
        bg={compact ? "transparent" : "bg.soft"}
        color="fg.muted"
        cursor="pointer"
        transition="background 120ms ease, color 120ms ease"
        _hover={{ bg: compact ? "bg.soft" : "bg.softHover", color: "fg" }}
      >
        <Search size={compact ? 16 : 14} />
        {compact ? null : (
          <>
            <Text fontSize="13px" flex="1" textAlign="left">
              Search docs
            </Text>
            <ShortcutHint />
          </>
        )}
      </chakra.button>
      {host ? <SearchHost open={open} /> : null}
    </>
  );
}
