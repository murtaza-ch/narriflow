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
 * Blueline action menu (the kebab / "…" overflow pattern) on Chakra v3 Menu.
 *
 * Elevation only — a menu is one of the few surfaces that genuinely floats, so
 * it takes `layerStyle="panel"` where the rest of the app draws structure with
 * rules. Destructive items are grouped last behind a separator so the
 * irreversible action is never adjacent to an ordinary one.
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
        gap="2.5"
        px="2"
        py="1.5"
        borderRadius="l1"
        fontSize="13.5px"
        color={item.destructive ? "danger.fg" : "fg"}
        cursor="pointer"
        _highlighted={{ bg: item.destructive ? "danger.subtle" : "bg.subtle" }}
        _disabled={{ color: "fg.disabled", cursor: "not-allowed" }}
      >
        {/* Plain span, never Menu.ItemText — ItemText is a styled text slot
            that claims flex space, so using it for the icon squeezed the label
            into an ellipsis and pushed it to the right edge. */}
        {item.busy ? (
          <Spinner size="xs" flexShrink={0} />
        ) : item.icon ? (
          <Box
            as="span"
            display="flex"
            alignItems="center"
            flexShrink={0}
            color={item.destructive ? "danger.fg" : "fg.muted"}
            aria-hidden="true"
          >
            {item.icon}
          </Box>
        ) : null}
        <ChakraMenu.ItemText flex="1" textAlign="start" truncate>
          {item.label}
        </ChakraMenu.ItemText>
        {item.hint ? (
          <ChakraMenu.ItemCommand
            fontSize="10px"
            letterSpacing="0.06em"
            color="fg.subtle"
            flexShrink={0}
          >
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
          <ChakraMenu.Content
            layerStyle="panel"
            boxShadow="cardHover"
            borderRadius="l3"
            minW="200px"
            p="1"
            aria-label={ariaLabel}
          >
            {ordinary.map(renderItem)}
            {destructive.length > 0 && ordinary.length > 0 ? (
              <ChakraMenu.Separator
                borderColor="border.subtle"
                my="1"
                mx="1"
              />
            ) : null}
            {destructive.map(renderItem)}
          </ChakraMenu.Content>
        </ChakraMenu.Positioner>
      </Portal>
    </ChakraMenu.Root>
  )
}
