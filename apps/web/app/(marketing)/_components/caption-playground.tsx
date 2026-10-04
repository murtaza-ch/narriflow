"use client";

import { useMemo, useRef, useState } from "react";
import { Box, chakra, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { buildScript, captionStyleFromPreset, caption, footage, P } from "@narriflow/stage";
import { CAPTION_PRESETS } from "@narriflow/validators";
import { Input } from "@narriflow/ui/components/input";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { useStageCanvas } from "./stage/use-stage-canvas";

/*
 * Caption playground: all twelve real presets from @narriflow/validators,
 * drawn live over the procedural footage with the stage caption renderer.
 * Hover or focus previews a preset, click selects it, and the line is yours
 * to type. Preset colours are product output values (the sanctioned literal
 * exception), so they are not re-themed.
 */

const Canvas = chakra("canvas");
const DEFAULT_LINE = "Captions that stop the scroll.";

// Font families as app/layout.tsx exposes them; Impact exports as Anton.
const FONT_VARS: Record<string, string> = {
  "Bebas Neue": "var(--font-caption-bebas-neue)",
  Anton: "var(--font-caption-anton)",
  Impact: "var(--font-caption-anton)",
  Montserrat: "var(--font-caption-montserrat)",
  Oswald: "var(--font-caption-oswald)",
  Roboto: "var(--font-caption-roboto)",
  "Open Sans": "var(--font-caption-open-sans)",
};

const STYLES = CAPTION_PRESETS.map((named) => ({ id: named.id, style: captionStyleFromPreset(named), preset: named.preset }));

export function CaptionPlayground() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selected, setSelected] = useState<string>("karaoke");
  const [preview, setPreview] = useState<string | null>(null);
  const [line, setLine] = useState(DEFAULT_LINE);

  const activeId = preview ?? selected;
  const active = STYLES.find((s) => s.id === activeId) ?? STYLES[0]!;
  const script = useMemo(() => buildScript([{ speaker: 0, text: line.trim() || DEFAULT_LINE }]), [line]);

  useStageCanvas(
    canvasRef,
    (ctx, w, h, now) => {
      ctx.fillStyle = P.night;
      ctx.fillRect(0, 0, w, h);
      const loop = script.duration + 0.9;
      const st = now % loop;
      const cropH = 860;
      footage(ctx, { x: 0, y: 0, w, h }, now, st, 15, { cx: 660, cy: 540, w: cropH * (w / h), h: cropH }, script);
      const fs = Math.max(22, Math.min(56, w * 0.12));
      caption(ctx, st, active.style, w / 2, h * (active.style.center ? 0.42 : 0.64), fs, w * 0.86, script);
      // playback progress
      ctx.fillStyle = "rgba(255,255,255,0.16)";
      ctx.fillRect(w * 0.06, h - 18, w * 0.88, 3);
      ctx.fillStyle = "#FFFFFF";
      ctx.fillRect(w * 0.06, h - 18, w * 0.88 * (st / loop), 3);
    },
    { stillAt: 0.9 },
  );

  const choose = (id: string) => {
    setSelected(id);
  };

  return (
    <Grid templateColumns={{ base: "1fr", lg: "minmax(0, 1fr) 360px" }} gap={{ base: "10", lg: "16" }} alignItems="center">
      <Stack gap="8" order={{ base: 2, lg: 1 }}>
        <Box
          role="radiogroup"
          aria-label="Caption preset"
          display="grid"
          gridTemplateColumns={{ base: "repeat(3, 1fr)", xl: "repeat(4, 1fr)" }}
          gap="2.5"
          onMouseLeave={() => setPreview(null)}
        >
          {STYLES.map(({ id, style, preset }) => {
            const on = id === selected;
            return (
              <chakra.button
                key={id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => choose(id)}
                onMouseEnter={() => {
                  setPreview(id);
                }}
                onFocus={() => setPreview(id)}
                onBlur={() => setPreview(null)}
                textAlign="left"
                borderWidth="1px"
                borderColor={on ? "accent.solid" : "border"}
                borderRadius="l2"
                bg="bg"
                p="2"
                cursor="pointer"
                transition="border-color 160ms ease, transform 160ms ease"
                _hover={{ borderColor: on ? "accent.solid" : "border.emphasized", transform: "translateY(-2px)" }}
                _focusVisible={{ outline: "2px solid", outlineColor: "accent.solid", outlineOffset: "2px" }}
              >
                <Flex
                  h={{ base: "44px", md: "54px" }}
                  align="center"
                  justify="center"
                  borderRadius="l1"
                  bg="studio.canvas"
                  overflow="hidden"
                  aria-hidden="true"
                >
                  <Text
                    as="span"
                    fontSize="22px"
                    lineHeight="1"
                    px="1.5"
                    borderRadius="3px"
                    textTransform={style.transform}
                    style={{
                      fontFamily: FONT_VARS[preset.fontName] ?? "inherit",
                      fontWeight: style.weight,
                      letterSpacing: `${style.letterSpacing}em`,
                      color: style.highlight,
                      background: style.box ?? style.background,
                      textShadow: [
                        style.outlineWidth ? `0 0 2px ${style.outline}, 0 1px 2px ${style.outline}` : "",
                        style.glow ? `0 0 10px ${style.glow}` : "",
                      ]
                        .filter(Boolean)
                        .join(", ") || undefined,
                    }}
                  >
                    Aa
                  </Text>
                </Flex>
                <Flex mt="2" align="center" justify="space-between" gap="2">
                  <Text textStyle="eyebrow" color={on ? "fg" : "fg.muted"} truncate>
                    {style.name}
                  </Text>
                  <Box w="7px" h="7px" flexShrink={0} bg={on ? "accent.solid" : "transparent"} />
                </Flex>
              </chakra.button>
            );
          })}
        </Box>
        <Stack gap="2" maxW="520px">
          <chakra.label htmlFor="caption-line" textStyle="eyebrow" color="fg.subtle">
            Try your own line
          </chakra.label>
          <Input
            id="caption-line"
            value={line}
            maxLength={80}
            onChange={(event) => {
              setLine(event.target.value);
            }}
            placeholder={DEFAULT_LINE}
            size="lg"
          />
        </Stack>
      </Stack>
      <MediaWell
        ratio={9 / 16}
        w="full"
        maxW={{ base: "280px", lg: "360px" }}
        mx="auto"
        order={{ base: 1, lg: 2 }}
        borderColor="border.emphasized"
      >
        <Canvas ref={canvasRef} position="absolute" inset="0" w="full" h="full" display="block" aria-hidden="true" />
        <Box position="absolute" top="3" left="3" px="2" py="1" borderRadius="l1" bg="studio.scrim">
          <Text textStyle="data" fontSize="11px" color="studio.fg" letterSpacing="0.1em" textTransform="uppercase">
            {active.style.name}
          </Text>
        </Box>
      </MediaWell>
    </Grid>
  );
}
