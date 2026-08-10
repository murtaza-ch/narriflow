"use client";

import { Box, Dialog, Flex, Portal, Text } from "@chakra-ui/react";
import { X } from "lucide-react";
import { useStudio } from "./studio-shell";

// Only shortcuts the shell actually implements are listed.
const SHORTCUTS = [
  { command: "Play / Pause",                 win: "Space",             mac: "Space" },
  { command: "Zoom in",                      win: "+",                 mac: "+" },
  { command: "Zoom out",                     win: "-",                 mac: "-" },
  { command: "Resize timeline to fit",       win: "\\",                mac: "\\" },
  { command: "Move forward to next frame",   win: "Right arrow (→)",   mac: "Right arrow (→)" },
  { command: "Move backward to prev frame",  win: "Left arrow (←)",    mac: "Left arrow (←)" },
  { command: "Jump forward 5 seconds",       win: "Shift + →",         mac: "Shift + →" },
  { command: "Jump back 5 seconds",          win: "Shift + ←",         mac: "Shift + ←" },
  { command: "Split clips",                  win: "D or Ctrl+B",       mac: "D or Ctrl+B" },
  { command: "Delete clips",                 win: "Backspace (⌫)",     mac: "Backspace (⌫)" },
  { command: "Create clip from selection",   win: "Ctrl+Shift+C",      mac: "⇧⌘C" },
  { command: "Back to start",                win: "1 or Home",         mac: "1 or Home or Fn+←" },
  { command: "Go to end",                    win: "End",               mac: "Fn + Right Arrow (→)" },
  { command: "Undo",                         win: "Ctrl+Z",            mac: "⌘Z" },
  { command: "Redo",                         win: "Ctrl+Shift+Z",      mac: "⌘⇧Z" },
  { command: "Toggle timeline",              win: "H",                 mac: "H" },
  { command: "Toggle timeline snapping",     win: "N",                 mac: "N" },
  { command: "Open shortcuts",               win: "?",                 mac: "?" },
  { command: "Close / Cancel",               win: "Esc",               mac: "Esc" },
];

function KbdTag({ children }: { children: string }) {
  return (
    <Box
      as="span"
      display="inline-block"
      px="6px"
      py="2px"
      bg="studio.raised"
      borderWidth="1px"
      borderColor="studio.borderStrong"
      borderRadius="l1"
      fontSize="11px"
      fontFamily="mono"
      color="studio.fg"
      letterSpacing="0.03em"
    >
      {children}
    </Box>
  );
}

/**
 * Keyboard shortcuts reference — a Chakra Dialog. Rendered in a portal, so it
 * styles exclusively with mode-invariant studio.* tokens.
 */
export function KeyboardShortcutsModal() {
  const { showShortcuts, setShowShortcuts } = useStudio();

  return (
    <Dialog.Root
      open={showShortcuts}
      onOpenChange={(e) => setShowShortcuts(e.open)}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop bg="rgba(0,0,0,0.7)" zIndex={300} />
        <Dialog.Positioner zIndex={310}>
          <Dialog.Content
            bg="studio.surface"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            borderRadius="l3"
            w="min(860px, 90vw)"
            maxW="min(860px, 90vw)"
            maxH="80vh"
            overflow="hidden"
            display="flex"
            flexDirection="column"
            boxShadow="0 24px 60px rgba(0,0,0,0.7)"
            color="studio.fg"
          >
            {/* Header */}
            <Flex
              px="6"
              py="4"
              align="center"
              justify="space-between"
              borderBottomWidth="1px"
              borderColor="studio.border"
              flexShrink={0}
            >
              <Dialog.Title asChild>
                <Text
                  fontFamily="display"
                  fontSize="15px"
                  fontWeight="600"
                  color="studio.fg"
                >
                  Keyboard shortcuts
                </Text>
              </Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <Flex
                  as="button"
                  aria-label="Close keyboard shortcuts"
                  align="center"
                  justify="center"
                  w="28px"
                  h="28px"
                  borderRadius="l1"
                  bg="transparent"
                  border="none"
                  color="studio.fgMuted"
                  cursor="pointer"
                  _hover={{ color: "studio.fg", bg: "studio.raised" }}
                  transition="background 120ms ease, color 120ms ease"
                >
                  <X size={16} />
                </Flex>
              </Dialog.CloseTrigger>
            </Flex>

            {/* Table */}
            <Box
              overflowY="auto"
              css={{
                "&::-webkit-scrollbar": { width: "4px" },
                "&::-webkit-scrollbar-thumb": {
                  background: "var(--chakra-colors-studio-raised)",
                  borderRadius: "4px",
                },
              }}
            >
              {/* Column headers */}
              <Flex
                px="6"
                py="2.5"
                bg="studio.subtle"
                borderBottomWidth="1px"
                borderColor="studio.border"
                position="sticky"
                top="0"
                zIndex={1}
              >
                <Text flex="2" textStyle="eyebrow" color="studio.fgMuted">
                  Command
                </Text>
                <Text flex="1" textStyle="eyebrow" color="studio.fgMuted">
                  Windows
                </Text>
                <Text flex="1" textStyle="eyebrow" color="studio.fgMuted">
                  macOS
                </Text>
              </Flex>

              {SHORTCUTS.map((row) => (
                <Flex
                  key={row.command}
                  px="6"
                  py="3"
                  align="center"
                  borderBottomWidth="1px"
                  borderColor="studio.border"
                  _hover={{ bg: "studio.subtle" }}
                  transition="background 120ms ease"
                >
                  <Text flex="2" fontSize="13px" color="studio.fg">
                    {row.command}
                  </Text>
                  <Box flex="1">
                    <KbdTag>{row.win}</KbdTag>
                  </Box>
                  <Box flex="1">
                    <KbdTag>{row.mac}</KbdTag>
                  </Box>
                </Flex>
              ))}

              <Box h="4" />
            </Box>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
