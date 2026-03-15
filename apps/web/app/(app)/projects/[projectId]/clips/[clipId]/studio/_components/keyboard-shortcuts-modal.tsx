"use client";

import { Box, Flex, Text } from "@chakra-ui/react";
import { X } from "lucide-react";
import { useStudio } from "./studio-shell";

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
  { command: "Back to start",                win: "1 or Home",         mac: "1 or Home or Fn+←" },
  { command: "Go to end",                    win: "End",               mac: "Fn + Right Arrow (→)" },
  { command: "Crop",                         win: "X",                 mac: "X" },
  { command: "Undo",                         win: "Ctrl+Z",            mac: "⌘Z" },
  { command: "Redo",                         win: "Ctrl+Shift+Z",      mac: "⌘⇧Z" },
  { command: "Toggle timeline",              win: "H",                 mac: "H" },
  { command: "Toggle transcript panel",      win: "T",                 mac: "T" },
  { command: "Open shortcuts",               win: "?",                 mac: "?" },
  { command: "Close / Cancel",              win: "Esc",               mac: "Esc" },
];

function KbdTag({ children }: { children: string }) {
  return (
    <Box
      as="span"
      display="inline-block"
      px="6px"
      py="2px"
      bg="#1e1e1e"
      border="1px solid #333"
      borderRadius="4px"
      fontSize="11px"
      fontFamily="mono"
      color="#ccc"
      letterSpacing="0.03em"
    >
      {children}
    </Box>
  );
}

export function KeyboardShortcutsModal() {
  const { showShortcuts, setShowShortcuts } = useStudio();

  if (!showShortcuts) return null;

  return (
    <>
      {/* Backdrop */}
      <Box
        position="fixed"
        inset="0"
        bg="rgba(0,0,0,0.7)"
        zIndex={300}
        onClick={() => setShowShortcuts(false)}
      />

      {/* Modal */}
      <Box
        position="fixed"
        top="50%"
        left="50%"
        transform="translate(-50%, -50%)"
        zIndex={310}
        bg="#141414"
        borderWidth="1px"
        borderColor="#2a2a2a"
        borderRadius="12px"
        w="min(860px, 90vw)"
        maxH="80vh"
        overflow="hidden"
        display="flex"
        flexDirection="column"
        boxShadow="0 24px 60px rgba(0,0,0,0.7)"
      >
        {/* Header */}
        <Flex
          px="24px"
          py="16px"
          align="center"
          justify="space-between"
          borderBottomWidth="1px"
          borderColor="#1e1e1e"
          flexShrink={0}
        >
          <Text fontSize="15px" fontWeight="600" color="#e5e5e5">
            Keyboard Shortcuts
          </Text>
          <Box
            as="button"
            onClick={() => setShowShortcuts(false)}
            p="6px"
            borderRadius="6px"
            bg="transparent"
            border="none"
            color="#555"
            cursor="pointer"
            _hover={{ color: "#aaa", bg: "#1e1e1e" }}
            transition="all 150ms"
          >
            <X size={16} />
          </Box>
        </Flex>

        {/* Table */}
        <Box
          overflowY="auto"
          css={{
            "&::-webkit-scrollbar": { width: "4px" },
            "&::-webkit-scrollbar-thumb": { background: "#2a2a2a", borderRadius: "4px" },
          }}
        >
          {/* Column headers */}
          <Flex
            px="24px"
            py="10px"
            bg="#0f0f0f"
            borderBottomWidth="1px"
            borderColor="#1e1e1e"
            position="sticky"
            top="0"
          >
            <Text flex="2" fontSize="11px" fontWeight="600" color="#555" textTransform="uppercase" letterSpacing="0.06em">
              Command
            </Text>
            <Text flex="1" fontSize="11px" fontWeight="600" color="#555" textTransform="uppercase" letterSpacing="0.06em">
              Windows
            </Text>
            <Text flex="1" fontSize="11px" fontWeight="600" color="#555" textTransform="uppercase" letterSpacing="0.06em">
              macOS
            </Text>
          </Flex>

          {SHORTCUTS.map((row, i) => (
            <Flex
              key={i}
              px="24px"
              py="12px"
              align="center"
              borderBottomWidth="1px"
              borderColor="#1a1a1a"
              _hover={{ bg: "#111" }}
              transition="background 100ms"
            >
              <Text flex="2" fontSize="13px" color="#c4c4c4">
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

          <Box h="16px" />
        </Box>
      </Box>
    </>
  );
}
