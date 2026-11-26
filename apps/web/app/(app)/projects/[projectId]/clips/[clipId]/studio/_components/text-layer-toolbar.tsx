"use client";

/**
 * The floating toolbar under a selected Text Layer (title-text spec section 6): font, size,
 * alignment, case, text colour and a more menu (Duplicate, Delete, and Apply to all clips for a
 * title). It shows the same values as the Settings tab and changes the layer through the same
 * patches. Presentational; `TextLayerCanvas` places it. On a narrow preview (`compact`) it keeps
 * font, size, colour and more, and alignment and case move into the more menu.
 */

import { Box, Flex, Menu, Portal, Text } from "@chakra-ui/react";
import { AlignCenter, AlignLeft, AlignRight, CaseSensitive, Check, Copy, Ellipsis, Layers, Trash2 } from "lucide-react";
import type { TextLayerStyle } from "@narriflow/validators";
import { TextColorSwatch, TextFontMenu, TextSizeField, type TextStyleChange } from "./tool-panels/text-style-controls";

const ALIGN_ICON = { left: <AlignLeft size={16} />, center: <AlignCenter size={16} />, right: <AlignRight size={16} /> } as const;
const ALIGN_LABEL = { left: "Left", center: "Centre", right: "Right" } as const;

const iconButton = {
  as: "button",
  boxSize: "32px",
  align: "center",
  justify: "center",
  borderRadius: "8px",
  color: "studio.fgMuted",
  cursor: "pointer",
  transition: "background 120ms ease, color 120ms ease",
  _hover: { bg: "studio.raised", color: "studio.fg" },
} as const;

const menuContentProps = { p: "1", bg: "studio.surface", borderWidth: "0", borderRadius: "12px", boxShadow: "none", color: "studio.fg", minW: "180px" } as const;
const menuItemProps = { gap: "2.5", h: "36px", px: "2.5", borderRadius: "8px", color: "studio.fg", bg: "transparent", cursor: "pointer", _hover: { bg: "studio.raised" }, _highlighted: { bg: "studio.raised" } } as const;

const Divider = () => <Box w="1px" h="18px" bg="studio.border" mx="1" aria-hidden />;

export interface TextLayerToolbarProps {
  readonly style: TextLayerStyle;
  readonly onChange: TextStyleChange;
  readonly onGestureEnd?: () => void;
  readonly onDuplicate: () => void;
  readonly onDelete: () => void;
  /** Present for a title: Apply its style, place and timing to every clip. */
  readonly onApplyToAll?: () => void;
  /** Why Duplicate cannot add a layer now (the clip is full); Duplicate says so instead of acting. */
  readonly duplicateBlockedReason?: string | null;
  /** Narrow preview: alignment and case go into the more menu. */
  readonly compact?: boolean;
}

export function TextLayerToolbar({ style, onChange, onGestureEnd, onDuplicate, onDelete, onApplyToAll, duplicateBlockedReason, compact = false }: TextLayerToolbarProps) {
  const toggledCase = style.textCase === "uppercase" ? "none" : "uppercase";
  return (
    <Flex align="center" gap="0.5" p="1" bg="studio.surface" borderRadius="12px" color="studio.fg" data-compact={compact || undefined}>
      <Box w={compact ? "104px" : "132px"}>
        <TextFontMenu value={style} onChange={onChange} compact />
      </Box>
      <Divider />
      <TextSizeField value={style.fontSize} onChange={(fontSize) => onChange({ fontSize })} compact />
      {compact ? null : (
        <>
      <Divider />
      <Menu.Root onSelect={({ value }) => onChange({ align: value as TextLayerStyle["align"] })} positioning={{ placement: "bottom" }} lazyMount>
        <Menu.Trigger asChild>
          <Flex {...iconButton} aria-label={`Alignment: ${ALIGN_LABEL[style.align]}`}>
            {ALIGN_ICON[style.align]}
          </Flex>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content {...menuContentProps} minW="150px">
              {(["left", "center", "right"] as const).map((align) => (
                <Menu.Item key={align} value={align} {...menuItemProps}>
                  <Box color="studio.fgMuted">{ALIGN_ICON[align]}</Box>
                  <Text fontSize="14px">{ALIGN_LABEL[align]}</Text>
                  <Box ms="auto" w="16px" color="studio.accentFg">
                    {style.align === align ? <Check size={16} /> : null}
                  </Box>
                </Menu.Item>
              ))}
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
      <Flex
        {...iconButton}
        w="36px"
        fontSize="14px"
        fontWeight="600"
        aria-label={style.textCase === "uppercase" ? "Uppercase (switch to as typed)" : "As typed (switch to uppercase)"}
        aria-pressed={style.textCase === "uppercase"}
        onClick={() => onChange({ textCase: style.textCase === "uppercase" ? "none" : "uppercase" })}
      >
        {style.textCase === "uppercase" ? "AB" : "Aa"}
      </Flex>
        </>
      )}
      <Box px="1">
        <TextColorSwatch label="Text colour" value={style.color} onChange={(color) => onChange({ color }, "color")} onGestureEnd={onGestureEnd} size="26px" />
      </Box>
      <Menu.Root
        onSelect={({ value }) => {
          if (value === "duplicate") onDuplicate();
          else if (value === "delete") onDelete();
          else if (value === "apply-all") onApplyToAll?.();
          else if (value === "case") onChange({ textCase: toggledCase });
          else if (value.startsWith("align-")) onChange({ align: value.slice("align-".length) as TextLayerStyle["align"] });
        }}
        positioning={{ placement: "bottom-end" }}
        lazyMount
      >
        <Menu.Trigger asChild>
          <Flex {...iconButton} aria-label="More text actions">
            <Ellipsis size={16} />
          </Flex>
        </Menu.Trigger>
        <Portal>
          <Menu.Positioner>
            <Menu.Content {...menuContentProps} minW="220px">
              {compact ? (
                <>
                  {(["left", "center", "right"] as const).map((align) => (
                    <Menu.Item key={align} value={`align-${align}`} {...menuItemProps} aria-label={`Align ${ALIGN_LABEL[align].toLowerCase()}`}>
                      <Box color="studio.fgMuted">{ALIGN_ICON[align]}</Box>
                      <Text fontSize="14px">Align {ALIGN_LABEL[align].toLowerCase()}</Text>
                      <Box ms="auto" w="16px" color="studio.accentFg">
                        {style.align === align ? <Check size={16} /> : null}
                      </Box>
                    </Menu.Item>
                  ))}
                  <Menu.Item value="case" {...menuItemProps} aria-label={style.textCase === "uppercase" ? "Uppercase (on): switch to as typed" : "Uppercase (off): switch to uppercase"}>
                    <Box color="studio.fgMuted">
                      <CaseSensitive size={16} />
                    </Box>
                    <Text fontSize="14px">Uppercase</Text>
                    <Box ms="auto" w="16px" color="studio.accentFg">
                      {style.textCase === "uppercase" ? <Check size={16} /> : null}
                    </Box>
                  </Menu.Item>
                  <Menu.Separator bg="studio.border" my="1" />
                </>
              ) : null}
              <Menu.Item value="duplicate" {...menuItemProps} {...(duplicateBlockedReason ? { h: "auto", py: "2", alignItems: "flex-start" } : {})}>
                <Box color="studio.fgMuted" pt={duplicateBlockedReason ? "0.5" : "0"}>
                  <Copy size={15} />
                </Box>
                <Box>
                  <Text fontSize="14px">Duplicate</Text>
                  {duplicateBlockedReason ? (
                    <Text fontSize="12px" color="studio.fgMuted" lineHeight="1.4" maxW="200px">
                      {duplicateBlockedReason}
                    </Text>
                  ) : null}
                </Box>
              </Menu.Item>
              {onApplyToAll ? (
                <Menu.Item value="apply-all" {...menuItemProps}>
                  <Box color="studio.fgMuted">
                    <Layers size={15} />
                  </Box>
                  <Text fontSize="14px">Apply to all clips</Text>
                </Menu.Item>
              ) : null}
              <Menu.Item value="delete" {...menuItemProps} color="studio.danger" _hover={{ bg: "studio.raised" }}>
                <Trash2 size={15} />
                <Text fontSize="14px">Delete</Text>
              </Menu.Item>
            </Menu.Content>
          </Menu.Positioner>
        </Portal>
      </Menu.Root>
    </Flex>
  );
}
