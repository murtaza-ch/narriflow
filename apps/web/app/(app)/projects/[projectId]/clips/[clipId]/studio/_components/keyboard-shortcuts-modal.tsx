"use client";

import { Fragment } from "react";
import { Box, Dialog, Flex, Grid, Portal, Stack, Text } from "@chakra-ui/react";
import { X } from "lucide-react";
import { useStudio } from "./studio-shell";
import { useIsMac } from "./use-is-mac";

/** One way to press a shortcut: the keys held together, e.g. ["⌘", "Z"]. */
type Combo = readonly string[];
type Shortcut = { command: string; win: readonly Combo[]; mac: readonly Combo[] };

type Group = { title: string; shortcuts: readonly Shortcut[] };

// Only shortcuts the shell actually implements are listed, in two columns of
// about equal height.
const COLUMNS: readonly (readonly Group[])[] = [
  [
    {
      title: "Playback",
      shortcuts: [
        { command: "Play or pause", win: [["Space"]], mac: [["Space"]] },
        { command: "Next frame", win: [["→"]], mac: [["→"]] },
        { command: "Previous frame", win: [["←"]], mac: [["←"]] },
        { command: "Forward 5 seconds", win: [["Shift", "→"]], mac: [["⇧", "→"]] },
        { command: "Back 5 seconds", win: [["Shift", "←"]], mac: [["⇧", "←"]] },
        { command: "Back to start", win: [["1"], ["Home"]], mac: [["1"], ["Home"], ["Fn", "←"]] },
        { command: "Go to end", win: [["End"]], mac: [["Fn", "→"]] },
      ],
    },
    {
      title: "General",
      shortcuts: [
        { command: "Keyboard shortcuts", win: [["?"]], mac: [["?"]] },
        { command: "Close or cancel", win: [["Esc"]], mac: [["Esc"]] },
      ],
    },
  ],
  [
    {
      title: "Editing",
      shortcuts: [
        { command: "Split at playhead", win: [["D"], ["Ctrl", "B"]], mac: [["D"], ["⌘", "B"]] },
        { command: "Delete selected", win: [["Backspace"], ["Delete"]], mac: [["⌫"]] },
        { command: "Clip from selection", win: [["Ctrl", "Shift", "C"]], mac: [["⇧", "⌘", "C"]] },
        { command: "Undo", win: [["Ctrl", "Z"]], mac: [["⌘", "Z"]] },
        { command: "Redo", win: [["Ctrl", "Shift", "Z"]], mac: [["⌘", "⇧", "Z"]] },
      ],
    },
    {
      title: "Timeline",
      shortcuts: [
        { command: "Zoom in", win: [["+"]], mac: [["+"]] },
        { command: "Zoom out", win: [["-"]], mac: [["-"]] },
        { command: "Zoom to fit", win: [["\\"]], mac: [["\\"]] },
        { command: "Show or hide timeline", win: [["H"]], mac: [["H"]] },
        { command: "Snapping on or off", win: [["N"]], mac: [["N"]] },
      ],
    },
  ],
];

/** A flat key cap: a raised chip, no bevel or shadow. */
function Key({ children }: { children: string }) {
  return (
    <Flex
      as="kbd"
      align="center"
      justify="center"
      minW="24px"
      h="24px"
      px="6px"
      borderRadius="6px"
      bg="studio.raised"
      color="studio.fg"
      fontFamily="body"
      fontSize="12px"
      fontWeight="500"
      lineHeight="1"
    >
      {children}
    </Flex>
  );
}

function Keys({ combos }: { combos: readonly Combo[] }) {
  return (
    <Flex align="center" gap="1.5" flexShrink={0}>
      {combos.map((combo, index) => (
        <Fragment key={combo.join("+")}>
          {index > 0 ? (
            <Text fontSize="11px" color="studio.fgSubtle" px="0.5">
              or
            </Text>
          ) : null}
          <Flex gap="1">
            {combo.map((key) => (
              <Key key={key}>{key}</Key>
            ))}
          </Flex>
        </Fragment>
      ))}
    </Flex>
  );
}

/**
 * Keyboard shortcuts reference — a Chakra Dialog. Rendered in a portal, so it
 * styles exclusively with mode-invariant studio.* tokens. Shows the keys for
 * the platform the editor is running on.
 */
export function KeyboardShortcutsModal() {
  const { showShortcuts, setShowShortcuts } = useStudio("showShortcuts", "setShowShortcuts");
  const isMac = useIsMac();

  return (
    <Dialog.Root
      open={showShortcuts}
      onOpenChange={(e) => setShowShortcuts(e.open)}
      placement="center"
    >
      <Portal>
        <Dialog.Backdrop zIndex={300} />
        <Dialog.Positioner zIndex={310}>
          <Dialog.Content
            w="min(760px, 92vw)"
            maxW="min(760px, 92vw)"
            maxH="84vh"
            overflow="hidden"
            display="flex"
            flexDirection="column"
            bg="studio.surface"
            color="studio.fg"
            borderRadius="14px"
          >
            {/* Header */}
            <Flex px="6" pt="5" pb="1" align="center" justify="space-between" flexShrink={0}>
              <Dialog.Title asChild>
                <Text fontSize="17px" fontWeight="500" letterSpacing="-0.01em" color="studio.fg">
                  Keyboard shortcuts
                </Text>
              </Dialog.Title>
              <Dialog.CloseTrigger asChild>
                <Flex
                  as="button"
                  aria-label="Close keyboard shortcuts"
                  title="Close (Esc)"
                  align="center"
                  justify="center"
                  boxSize="32px"
                  borderRadius="8px"
                  bg="transparent"
                  border="none"
                  color="studio.fgMuted"
                  cursor="pointer"
                  _hover={{ color: "studio.fg", bg: "studio.raised" }}
                  _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "1px" }}
                  transition="background 120ms ease, color 120ms ease"
                >
                  <X size={16} />
                </Flex>
              </Dialog.CloseTrigger>
            </Flex>

            <Box
              overflowY="auto"
              px="4"
              pt="3"
              pb="5"
              css={{
                "&::-webkit-scrollbar": { width: "4px" },
                "&::-webkit-scrollbar-thumb": {
                  background: "var(--chakra-colors-studio-raised)",
                  borderRadius: "4px",
                },
              }}
            >
              <Grid
                templateColumns={{ base: "1fr", md: "repeat(2, minmax(0, 1fr))" }}
                columnGap="6"
                rowGap="6"
              >
                {COLUMNS.map((groups) => (
                  <Stack key={groups.map((group) => group.title).join()} gap="6">
                    {groups.map((group) => (
                      <Box key={group.title}>
                        <Text fontSize="13px" fontWeight="500" color="studio.fgMuted" mb="1.5" px="2">
                          {group.title}
                        </Text>
                        <Stack gap="0">
                          {group.shortcuts.map((shortcut) => (
                            <Flex
                              key={shortcut.command}
                              align="center"
                              justify="space-between"
                              gap="4"
                              minH="36px"
                              px="2"
                              borderRadius="8px"
                              transition="background 120ms ease"
                              _hover={{ bg: "studio.subtle" }}
                            >
                              <Text fontSize="14px" color="studio.fg">
                                {shortcut.command}
                              </Text>
                              <Keys combos={isMac ? shortcut.mac : shortcut.win} />
                            </Flex>
                          ))}
                        </Stack>
                      </Box>
                    ))}
                  </Stack>
                ))}
              </Grid>
            </Box>
          </Dialog.Content>
        </Dialog.Positioner>
      </Portal>
    </Dialog.Root>
  );
}
