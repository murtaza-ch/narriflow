"use client";

import { useCallback, useEffect, useState } from "react";
import { Box, Flex, Text } from "@chakra-ui/react";
import { Crop, Minus, Move, Plus, RotateCcw } from "lucide-react";
import type { SpeakerLayerTransform } from "@narriflow/validators";

type EditMode = "move" | "crop";
type ResizeDirection = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

const HANDLES: Array<{
  direction: ResizeDirection;
  cursor: string;
  style: React.CSSProperties;
}> = [
  { direction: "nw", cursor: "nwse-resize", style: { left: -5, top: -5 } },
  { direction: "n", cursor: "ns-resize", style: { left: "50%", top: -5 } },
  { direction: "ne", cursor: "nesw-resize", style: { right: -5, top: -5 } },
  { direction: "e", cursor: "ew-resize", style: { right: -5, top: "50%" } },
  { direction: "se", cursor: "nwse-resize", style: { right: -5, bottom: -5 } },
  { direction: "s", cursor: "ns-resize", style: { left: "50%", bottom: -5 } },
  { direction: "sw", cursor: "nesw-resize", style: { left: -5, bottom: -5 } },
  { direction: "w", cursor: "ew-resize", style: { left: -5, top: "50%" } },
];

const MIN_FRAME_SIZE = 0.08;

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

export function InteractiveSpeakerLayer({
  layer,
  canvasRef,
  selected,
  onSelect,
  onChange,
  onGestureEnd,
  onReset,
}: {
  layer: SpeakerLayerTransform;
  canvasRef: React.RefObject<HTMLDivElement | null>;
  selected: boolean;
  onSelect: () => void;
  onChange: (next: SpeakerLayerTransform, gesture: string) => void;
  onGestureEnd: () => void;
  onReset: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const [mode, setMode] = useState<EditMode>("move");

  useEffect(() => {
    if (!selected) setMode("move");
  }, [selected]);

  const beginPointerGesture = useCallback(
    (
      event: React.PointerEvent,
      kind: "body" | "rotate" | ResizeDirection,
    ) => {
      event.preventDefault();
      event.stopPropagation();
      if (!selected) {
        onSelect();
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const startX = event.clientX;
      const startY = event.clientY;
      const initial = { ...layer };
      const centerX = rect.left + (initial.frameX + initial.frameWidth / 2) * rect.width;
      const centerY = rect.top + (initial.frameY + initial.frameHeight / 2) * rect.height;
      const startAngle = Math.atan2(event.clientY - centerY, event.clientX - centerX);

      const handleMove = (moveEvent: PointerEvent) => {
        const dx = (moveEvent.clientX - startX) / Math.max(1, rect.width);
        const dy = (moveEvent.clientY - startY) / Math.max(1, rect.height);
        let next = { ...initial };

        if (kind === "body") {
          if (mode === "crop") {
            // Dragging the footage right reveals more source on the left.
            next.cropCxNorm = clamp(initial.cropCxNorm - dx / initial.cropZoom, 0, 1);
            next.cropCyNorm = clamp(initial.cropCyNorm - dy / initial.cropZoom, 0, 1);
          } else {
            next.frameX = clamp(initial.frameX + dx, 0, 1 - initial.frameWidth);
            next.frameY = clamp(initial.frameY + dy, 0, 1 - initial.frameHeight);
          }
        } else if (kind === "rotate") {
          const angle = Math.atan2(moveEvent.clientY - centerY, moveEvent.clientX - centerX);
          next.rotationDeg = clamp(
            initial.rotationDeg + ((angle - startAngle) * 180) / Math.PI,
            -180,
            180,
          );
        } else {
          let left = initial.frameX;
          let top = initial.frameY;
          let right = initial.frameX + initial.frameWidth;
          let bottom = initial.frameY + initial.frameHeight;
          if (kind.includes("w")) left = clamp(left + dx, 0, right - MIN_FRAME_SIZE);
          if (kind.includes("e")) right = clamp(right + dx, left + MIN_FRAME_SIZE, 1);
          if (kind.includes("n")) top = clamp(top + dy, 0, bottom - MIN_FRAME_SIZE);
          if (kind.includes("s")) bottom = clamp(bottom + dy, top + MIN_FRAME_SIZE, 1);
          next = {
            ...next,
            frameX: left,
            frameY: top,
            frameWidth: right - left,
            frameHeight: bottom - top,
          };
        }
        onChange(next, `speaker-${kind}-${layer.role}`);
      };
      const handleUp = () => {
        window.removeEventListener("pointermove", handleMove);
        window.removeEventListener("pointerup", handleUp);
        onGestureEnd();
      };
      window.addEventListener("pointermove", handleMove);
      window.addEventListener("pointerup", handleUp);
    },
    [canvasRef, layer, mode, onChange, onGestureEnd, onSelect, selected],
  );

  const changeZoom = useCallback(
    (delta: number) => {
      onChange(
        { ...layer, cropZoom: clamp(layer.cropZoom + delta, 1, 4) },
        `speaker-zoom-${layer.role}`,
      );
      onGestureEnd();
    },
    [layer, onChange, onGestureEnd],
  );

  return (
    <Box
      position="absolute"
      inset="0"
      zIndex={3}
      cursor={selected ? (mode === "crop" ? "grab" : "move") : "pointer"}
      onPointerDown={(event) => beginPointerGesture(event, "body")}
      onClick={(event) => {
        event.stopPropagation();
        onSelect();
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      borderWidth={selected ? "2px" : hovered ? "1px" : "0"}
      borderStyle={selected ? "solid" : "dashed"}
      borderColor="studio.accent"
    >
      {hovered && !selected && (
        <Flex
          position="absolute"
          right="4px"
          top="4px"
          h="20px"
          px="6px"
          align="center"
          gap="4px"
          bg="studio.accent"
          color="accent.contrast"
          borderRadius="l1"
          textStyle="eyebrow"
          fontSize="9px"
          pointerEvents="none"
        >
          Speaker · {layer.role}
        </Flex>
      )}

      {selected && (
        <>
          <Flex
            position="absolute"
            left="50%"
            top={layer.frameY < 0.08 ? "8px" : "-38px"}
            transform="translateX(-50%)"
            h="30px"
            align="center"
            gap="1px"
            px="3px"
            bg="studio.surface"
            color="studio.fg"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            borderRadius="l2"
            boxShadow="cardHover"
            onPointerDown={(event) => event.stopPropagation()}
            zIndex={20}
          >
            <ToolbarButton active={mode === "move"} label="Move" onClick={() => setMode("move")}>
              <Move size={13} />
            </ToolbarButton>
            <ToolbarButton active={mode === "crop"} label="Crop" onClick={() => setMode("crop")}>
              <Crop size={13} />
            </ToolbarButton>
            <ToolbarButton label="Zoom out" onClick={() => changeZoom(-0.1)}>
              <Minus size={13} />
            </ToolbarButton>
            <Text minW="32px" textAlign="center" fontSize="10px" textStyle="data">
              {layer.cropZoom.toFixed(1)}×
            </Text>
            <ToolbarButton label="Zoom in" onClick={() => changeZoom(0.1)}>
              <Plus size={13} />
            </ToolbarButton>
            <ToolbarButton label="Reset scene" onClick={onReset}>
              <RotateCcw size={13} />
            </ToolbarButton>
          </Flex>

          {HANDLES.map((handle) => (
            <Box
              key={handle.direction}
              position="absolute"
              w="10px"
              h="10px"
              bg="studio.surface"
              borderWidth="1.5px"
              borderColor="studio.accent"
              borderRadius="full"
              cursor={handle.cursor}
              style={{
                ...handle.style,
                transform: "translate(-50%, -50%)",
              }}
              onPointerDown={(event) => beginPointerGesture(event, handle.direction)}
              zIndex={10}
            />
          ))}
          <Box
            position="absolute"
            left="50%"
            bottom={layer.frameY + layer.frameHeight > 0.92 ? "8px" : "-28px"}
            w="20px"
            h="20px"
            transform="translateX(-50%)"
            bg="studio.surface"
            borderWidth="1.5px"
            borderColor="studio.accent"
            borderRadius="full"
            cursor="grab"
            onPointerDown={(event) => beginPointerGesture(event, "rotate")}
            aria-label="Rotate speaker layer"
          >
            <Box position="absolute" left="50%" top="-9px" h="9px" borderLeftWidth="1px" borderColor="studio.accent" />
          </Box>
        </>
      )}
    </Box>
  );
}

function ToolbarButton({
  children,
  label,
  active = false,
  onClick,
}: {
  children: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <Flex
      as="button"
      aria-label={label}
      title={label}
      align="center"
      justify="center"
      w="24px"
      h="24px"
      borderRadius="l1"
      bg={active ? "studio.raised" : "transparent"}
      color={active ? "studio.accentFg" : "studio.fgMuted"}
      cursor="pointer"
      _hover={{ bg: "studio.raised", color: "studio.fg" }}
      onClick={(event) => {
        event.stopPropagation();
        onClick();
      }}
    >
      {children}
    </Flex>
  );
}
