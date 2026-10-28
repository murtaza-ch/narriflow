"use client"

import { Box, Menu as ChakraMenu, Portal, Spinner } from "@chakra-ui/react"
import * as React from "react"

export interface ActionMenuItem {
  /** Stable id, also the value Chakra reports on select. */
  value: string
  label: string
  /** Leading glyph — pass a lucide icon at size 14. */
  icon?: React.ReactNode
  /** Trailing hint: a keyboard shortcut, or a marker like "AI". */
  hint?: React.ReactNode
  onSelect?: () => void
  disabled?: boolean
  /** Renders in danger colours and sits below a separator. */
  destructive?: boolean
  /** Swaps the leading icon for a spinner and blocks selection. */
  busy?: boolean
}

export interface ActionMenuProps {
  /** The trigger element. Wrapped in `asChild`, so it must accept a ref and
   *  spread props — an IconButton or Button, not a bare fragment. */
  trigger: React.ReactElement
  items: ActionMenuItem[]
  /** Accessible name for the menu itself, e.g. "Clip actions". */
  ariaLabel?: string
  positioning?: ChakraMenu.RootProps["positioning"]
}

/**
 * Action menu (the kebab / "…" overflow pattern) on Chakra v3 Menu. The theme's
 * menu recipe draws the flat surface and rows; each row leads with its icon in
 * a small soft tile that brightens with the row. Destructive items are grouped
 * last behind a separator, their tile tinted, so the irreversible action is
 * never adjacent to an ordinary one.
 */
export function ActionMenu({
  trigger,
  items,
  ariaLabel,
  positioning = { placement: "bottom-end" },
}: ActionMenuProps) {
  const ordinary = items.filter((item) => !item.destructive)
  const destructive = items.filter((item) => item.destructive)

  function renderItem(item: ActionMenuItem) {
    return (
      <ChakraMenu.Item
        key={item.value}
        value={item.value}
        disabled={item.disabled || item.busy}
        onSelect={item.onSelect}
        display="flex"
        alignItems="center"
        minH="10"
        ps="1.5"
        gap="2.5"
        color={item.destructive ? "danger.fg" : "fg"}
        fontWeight="500"
        _highlighted={{ bg: item.destructive ? "danger.subtle" : "bg.soft" }}
        _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
        css={{
          "&[data-highlighted] [data-menu-icon]": item.destructive
            ? { bg: "danger.muted" }
            : { bg: "bg.softHover", color: "fg" },
        }}
      >
        {/* Plain span, never Menu.ItemText — ItemText is a styled text slot
            that claims flex space, so using it for the icon squeezed the label
            into an ellipsis and pushed it to the right edge. */}
        {item.busy || item.icon ? (
          <Box
            as="span"
            data-menu-icon=""
            display="flex"
            alignItems="center"
            justifyContent="center"
            boxSize="7"
            flexShrink={0}
            borderRadius="8px"
            bg={item.destructive ? "danger.subtle" : "bg.soft"}
            color={item.destructive ? "danger.fg" : "fg.muted"}
            transition="background 120ms ease, color 120ms ease"
            aria-hidden="true"
          >
            {item.busy ? <Spinner size="xs" /> : item.icon}
          </Box>
        ) : null}
        <ChakraMenu.ItemText flex="1" textAlign="start" truncate>
          {item.label}
        </ChakraMenu.ItemText>
        {item.hint ? (
          <ChakraMenu.ItemCommand flexShrink={0}>
            {item.hint}
          </ChakraMenu.ItemCommand>
        ) : null}
      </ChakraMenu.Item>
    )
  }

  return (
    <ChakraMenu.Root positioning={positioning}>
      <ChakraMenu.Trigger asChild>{trigger}</ChakraMenu.Trigger>
      <Portal>
        <ChakraMenu.Positioner>
          <ChakraMenu.Content aria-label={ariaLabel}>
            {ordinary.map(renderItem)}
            {destructive.length > 0 && ordinary.length > 0 ? (
              <ChakraMenu.Separator />
            ) : null}
            {destructive.map(renderItem)}
          </ChakraMenu.Content>
        </ChakraMenu.Positioner>
      </Portal>
    </ChakraMenu.Root>
  )
}
