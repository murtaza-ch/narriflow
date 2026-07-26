"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Box, Flex, Grid, GridItem, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { SmoothScroll } from "../../_components/smooth-scroll";
import { VariantDial } from "../../_components/variant-dial";
import {
  CAPTION_PRESETS,
  PAIN_POINTS,
  PIPELINE,
  PLATFORMS,
  REPURPOSE_FORMATS,
  STATS,
  TIERS,
} from "../../_components/landing-data";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
}

const Video = chakra("video");

/* ------------------------------ system palette ---------------------------- */
/* Pinned per the System spec — tile chrome is drawn in these exact values.   */

const INK = "#101318";
const HAIRLINE = "#E2E4E9";
const HAIRLINE_HOVER = "#C4C9D2";
const TILE_BG = "#FFFFFF";
const TILE_SHADOW = "0 1px 2px rgba(14,16,19,0.05)";
const ULTRA = "#2438E8";
const GREEN = "#1D8A54";
const WELL = "#F3F4F7";

const TILE_HOVER = {
  transform: "translateY(-2px)",
  borderColor: HAIRLINE_HOVER,
} as const;

/* --------------------------------- hooks ---------------------------------- */

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return reduced;
}

/** Monotonic tick every `ms`. Disabled (stays 0) when `enabled` is false. */
function useLoop(ms: number, enabled: boolean) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const id = window.setInterval(() => setTick((t) => t + 1), ms);
    return () => window.clearInterval(id);
  }, [ms, enabled]);
  return tick;
}

/* ---------------------------------- nav ----------------------------------- */

function SystemNav() {
  return (
    <Flex
      as="header"
      position="fixed"
      top="0"
      insetX="0"
      zIndex="60"
      h="60px"
      px={{ base: "5", md: "10" }}
      align="center"
      justify="space-between"
      borderBottomWidth="1px"
      borderColor={HAIRLINE}
      bg="bg/85"
      backdropFilter="blur(14px) saturate(1.2)"
    >
      <Link href="/" aria-label="Narriflow home">
        <Logo size="md" />
      </Link>

      <HStack
        gap="8"
        position="absolute"
        left="50%"
        transform="translateX(-50%)"
        display={{ base: "none", md: "flex" }}
      >
        {(
          [
            ["Product", "#product"],
            ["Pricing", "#pricing"],
          ] as const
        ).map(([label, href]) => (
          <Link key={label} href={href}>
            <Text
              fontSize="13px"
              fontWeight="500"
              color="fg.muted"
              transition="color 140ms ease"
              _hover={{ color: "fg" }}
            >
              {label}
            </Text>
          </Link>
        ))}
      </HStack>

      <HStack gap="2">
        <Button variant="ghost" size="sm" asChild display={{ base: "none", md: "inline-flex" }}>
          <Link href="/sign-in">Sign in</Link>
        </Button>
        <Button size="sm" asChild>
          <Link href="/sign-up">Start free</Link>
        </Button>
      </HStack>
    </Flex>
  );
}

/* ---------------------------------- hero ----------------------------------- */

function Hero() {
  return (
    <Box pt={{ base: "120px", md: "140px" }} pb={{ base: "10", md: "14" }} textAlign="center">
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <HStack gap="2.5" justify="center" data-hero-el style={{ opacity: 0 }}>
          <Box boxSize="6px" borderRadius="full" style={{ background: GREEN }} aria-hidden />
          <Text textStyle="data" fontSize="11px" letterSpacing="0.16em" color="fg.subtle">
            THE CONTENT PIPELINE, IN ONE GRID
          </Text>
        </HStack>

        <Box
          as="h1"
          mt="5"
          fontFamily="display"
          fontWeight="700"
          letterSpacing="-0.03em"
          lineHeight="1.04"
          color="fg"
          mx="auto"
          maxW="16ch"
          css={{ fontSize: "clamp(40px, 5.4vw, 64px)" }}
          data-hero-el
          style={{ opacity: 0 }}
        >
          Drop in a recording. Ship everything.
        </Box>

        <Text
          mt="5"
          fontSize={{ base: "15px", md: "16px" }}
          color="fg.muted"
          lineHeight="1.6"
          mx="auto"
          maxW="58ch"
          data-hero-el
          style={{ opacity: 0 }}
        >
          AI clipping, captions, scores, repurposing and publishing — every piece below is live.
        </Text>

        <HStack gap="3" justify="center" mt="8" data-hero-el style={{ opacity: 0 }}>
          <Button variant="outline" size="lg" px="7" asChild>
            <Link href="/sign-up">Start free</Link>
          </Button>
          <Button variant="ghost" size="lg" asChild>
            <Link href="#product">See the grid ↓</Link>
          </Button>
        </HStack>
      </Box>
    </Box>
  );
}

/* ------------------------------ tile primitives ---------------------------- */

function TileLabel({ label }: { label: string }) {
  return (
    <HStack gap="2" mb="4" flexShrink={0}>
      <Box boxSize="6px" borderRadius="full" style={{ background: GREEN }} aria-hidden />
      <Text textStyle="data" fontSize="10px" letterSpacing="0.14em" color="fg.subtle">
        {label}
      </Text>
    </HStack>
  );
}

function Tile({
  label,
  children,
  colSpan,
  rowSpan,
  minH,
}: {
  label: string;
  children: React.ReactNode;
  colSpan?: { base?: number; md?: number; lg?: number };
  rowSpan?: { base?: number; md?: number; lg?: number };
  minH?: string;
}) {
  return (
    <GridItem
      data-tile
      colSpan={{ base: 1, ...colSpan }}
      rowSpan={{ base: 1, ...rowSpan }}
      bg={TILE_BG}
      borderWidth="1px"
      borderColor={HAIRLINE}
      borderRadius="16px"
      boxShadow={TILE_SHADOW}
      p="5"
      minH={{ base: minH ?? "200px", md: "auto" }}
      display="flex"
      flexDirection="column"
      overflow="hidden"
      transition="transform 200ms ease, border-color 200ms ease"
      _hover={TILE_HOVER}
    >
      <TileLabel label={label} />
      {children}
    </GridItem>
  );
}

/* ------------------------------- T1 · moments ------------------------------ */

function MomentTile() {
  return (
    <Tile
      label="MOMENT DETECTION · LIVE"
      colSpan={{ md: 2, lg: 2 }}
      rowSpan={{ md: 2, lg: 2 }}
      minH="320px"
    >
      <Box flex="1" position="relative" borderRadius="10px" overflow="hidden" bg={WELL}>
        <Video
          src="/videos/moment-detect.mp4"
          autoPlay
          muted
          loop
          playsInline
          preload="metadata"
          position="absolute"
          inset="0"
          w="full"
          h="full"
          objectFit="cover"
          aria-hidden
        />
      </Box>
    </Tile>
  );
}

/* -------------------------------- T2 · score ------------------------------- */

const SCORE_ROWS = [
  { time: "00:12:41", score: 92 },
  { time: "00:27:03", score: 87 },
  { time: "00:41:56", score: 81 },
] as const;

function ScoreTile() {
  return (
    <Tile label="VIRALITY ENGINE" rowSpan={{ md: 2, lg: 2 }}>
      <Flex flex="1" gap="4" align="stretch" aria-hidden>
        <Box flex="1">
          <HStack align="baseline" gap="1.5">
            <Text
              textStyle="data"
              fontWeight="600"
              fontSize={{ base: "56px", md: "64px" }}
              lineHeight="1"
              color="fg"
            >
              <span data-score-value>74</span>
            </Text>
            <Text textStyle="data" fontSize="12px" color="fg.subtle">
              /100
            </Text>
          </HStack>
          <Text mt="2" fontSize="12px" color="fg.muted" lineHeight="1.5">
            Every moment scored before you render a frame.
          </Text>
        </Box>
        <Box w="8px" borderRadius="full" bg={WELL} position="relative" overflow="hidden">
          <Box
            data-score-meter
            position="absolute"
            inset="0"
            borderRadius="full"
            bg={ULTRA}
            transformOrigin="bottom"
            style={{ transform: "scaleY(0.74)" }}
          />
        </Box>
      </Flex>

      <Stack gap="1" mt="4" aria-hidden>
        {SCORE_ROWS.map((r) => (
          <HStack
            key={r.time}
            data-score-row
            justify="space-between"
            px="2.5"
            py="1.5"
            borderRadius="8px"
            css={{
              opacity: 0.45,
              transition: "opacity 240ms ease, background 240ms ease",
              "&[data-active='true']": { opacity: 1, background: WELL },
            }}
          >
            <Text textStyle="data" fontSize="11px" color="fg.muted">
              {r.time}
            </Text>
            <Text textStyle="data" fontSize="11px" color="fg">
              → {r.score}
            </Text>
          </HStack>
        ))}
      </Stack>
    </Tile>
  );
}

/* ------------------------------ T3 · captions ------------------------------ */

const T3_PRESET_NAMES = ["Karaoke", "Fire", "Electric", "Luxe Gold", "Matrix"] as const;
const T3_PRESETS = CAPTION_PRESETS.filter((p) =>
  (T3_PRESET_NAMES as readonly string[]).includes(p.name),
);
const CAPTION_WORDS = ["Stop", "scrubbing", "timelines"] as const;

function CaptionTile({ reduced }: { reduced: boolean }) {
  const [preset, setPreset] = useState(0);
  const tick = useLoop(380, !reduced);
  const word = reduced ? 1 : tick % CAPTION_WORDS.length;
  const accent = T3_PRESETS[preset]?.accent ?? CAPTION_PRESETS[0].accent;

  return (
    <Tile label="CAPTION STUDIO · 12 PRESETS" rowSpan={{ md: 2, lg: 2 }}>
      <Flex
        flex="1"
        bg={INK}
        borderRadius="10px"
        align="center"
        justify="center"
        px="4"
        py="6"
        aria-hidden
      >
        <Flex gap="0.45em" flexWrap="wrap" justify="center">
          {CAPTION_WORDS.map((w, i) => (
            <Text
              key={w}
              fontFamily="display"
              fontWeight="800"
              textTransform="uppercase"
              fontSize={{ base: "20px", md: "22px" }}
              letterSpacing="-0.01em"
              lineHeight="1.15"
              transition="color 120ms ease, transform 120ms ease"
              style={{
                color: i === word ? accent : i < word ? "#FBFBFC" : "rgba(251,251,252,0.34)",
                transform: i === word ? "scale(1.06)" : "scale(1)",
              }}
            >
              {w}
            </Text>
          ))}
        </Flex>
      </Flex>

      <Flex gap="1.5" flexWrap="wrap" mt="4">
        {T3_PRESETS.map((p, i) => (
          <Box
            key={p.name}
            as="button"
            aria-pressed={i === preset}
            onClick={() => setPreset(i)}
            px="2"
            py="1"
            borderRadius="full"
            borderWidth="1px"
            borderColor={i === preset ? INK : HAIRLINE}
            bg={i === preset ? WELL : "transparent"}
            transition="border-color 160ms ease, background 160ms ease"
            _hover={{ borderColor: i === preset ? INK : HAIRLINE_HOVER }}
            cursor="pointer"
          >
            <HStack gap="1.5">
              <Box boxSize="6px" borderRadius="full" style={{ background: p.accent }} />
              <Text textStyle="data" fontSize="10px" color="fg">
                {p.name}
              </Text>
            </HStack>
          </Box>
        ))}
      </Flex>
    </Tile>
  );
}

/* ------------------------------- T4 · ratios ------------------------------- */

function RatioTile() {
  return (
    <Tile label="EVERY RATIO">
      <Flex flex="1" align="center" justify="space-between" gap="4" aria-hidden>
        <Flex w="104px" h="76px" align="center" justify="center" flexShrink={0}>
          <Box
            data-ratio-frame
            borderWidth="1.5px"
            borderColor="fg"
            borderRadius="6px"
            style={{ width: "40.5px", height: "72px" }}
          />
        </Flex>
        <Box textAlign="right">
          <Text textStyle="data" fontSize="16px" fontWeight="600" color="fg">
            <span data-ratio-label>9:16</span>
          </Text>
          <Text mt="1" textStyle="data" fontSize="10px" color="fg.subtle">
            ONE RENDER PASS
          </Text>
        </Box>
      </Flex>
    </Tile>
  );
}

/* ------------------------------ T5 · publishing ---------------------------- */

const POST_TIMES = ["09:00", "10:30", "12:00", "15:30", "18:00"] as const;

function PublishTile({ reduced }: { reduced: boolean }) {
  const tick = useLoop(1100, !reduced);
  const step = reduced ? 6 : tick % 7;

  return (
    <Tile label="DIRECT PUBLISHING">
      <Stack gap="1" flex="1" justify="center" aria-hidden>
        {PLATFORMS.map((name, i) => {
          const posted = i < step;
          return (
            <HStack key={name} justify="space-between">
              <Text textStyle="data" fontSize="10px" color="fg">
                {name}
              </Text>
              <HStack gap="1.5">
                <Box
                  boxSize="5px"
                  borderRadius="full"
                  transition="background 240ms ease, border-color 240ms ease"
                  style={{
                    background: posted ? GREEN : "transparent",
                    border: posted ? "none" : `1px solid ${HAIRLINE_HOVER}`,
                  }}
                />
                <Text
                  textStyle="data"
                  fontSize="9px"
                  letterSpacing="0.06em"
                  transition="color 240ms ease"
                  style={{ color: posted ? GREEN : "var(--chakra-colors-fg-subtle)" }}
                >
                  {posted ? `POSTED ${POST_TIMES[i]}` : "SCHEDULED"}
                </Text>
              </HStack>
            </HStack>
          );
        })}
      </Stack>
    </Tile>
  );
}

/* ------------------------------ T6 · repurpose ----------------------------- */

function RepurposeTile({ reduced }: { reduced: boolean }) {
  const tick = useLoop(1800, !reduced);
  const idx = reduced ? 0 : tick % REPURPOSE_FORMATS.length;
  const format = REPURPOSE_FORMATS[idx] ?? REPURPOSE_FORMATS[0];

  return (
    <Tile label="CONTENT SUITE">
      <Flex flex="1" direction="column" justify="center" gap="1.5" aria-hidden>
        <Text fontSize="13px" color="fg.muted">
          One transcript →
        </Text>
        <Box key={idx} animation="fade-up">
          <Text
            fontFamily="display"
            fontWeight="650"
            letterSpacing="-0.02em"
            fontSize="21px"
            color="fg"
          >
            {format.name}
          </Text>
        </Box>
      </Flex>
    </Tile>
  );
}

/* ------------------------------- T7 · dubbing ------------------------------ */

const DUB_LANGS = ["ES", "DE", "HI", "PT"] as const;

function DubTile({ reduced }: { reduced: boolean }) {
  const tick = useLoop(900, !reduced);
  const lit = reduced ? DUB_LANGS.length - 1 : (tick % (DUB_LANGS.length + 1)) - 1;

  return (
    <Tile label="AI DUBBING · PRO">
      <Flex flex="1" align="center" aria-hidden>
        <HStack gap="2" flexWrap="wrap">
          <Box px="2" py="1" borderRadius="6px" bg={INK}>
            <Text textStyle="data" fontSize="10px" color="#FBFBFC">
              EN
            </Text>
          </Box>
          <Text textStyle="data" fontSize="11px" color="fg.subtle">
            →
          </Text>
          {DUB_LANGS.map((lang, i) => {
            const on = i <= lit;
            return (
              <Box
                key={lang}
                px="2"
                py="1"
                borderRadius="6px"
                borderWidth="1px"
                transition="border-color 240ms ease, color 240ms ease"
                style={{ borderColor: on ? ULTRA : HAIRLINE }}
              >
                <Text
                  textStyle="data"
                  fontSize="10px"
                  transition="color 240ms ease"
                  style={{ color: on ? ULTRA : "var(--chakra-colors-fg-subtle)" }}
                >
                  {lang}
                </Text>
              </Box>
            );
          })}
        </HStack>
      </Flex>
    </Tile>
  );
}

/* ------------------------------ T8 · autopilot ----------------------------- */

const FEED = [
  "ep143.mp3 · detected → 6 clips queued",
  "ep144.mp3 · transcribing, word-level…",
  "ep145.mp3 · top moment scored 94",
  "ep146.mp3 · rendering 9:16 · captions burned",
  "ep147.mp3 · scheduled → 5 platforms",
  "ep148.mp3 · posted 09:00",
] as const;

function AutopilotTile({ reduced }: { reduced: boolean }) {
  const tick = useLoop(1600, !reduced);

  return (
    <Tile label="RSS AUTOPILOT" colSpan={{ md: 2, lg: 2 }}>
      <Stack gap="1.5" flex="1" justify="center" aria-hidden>
        {[0, 1, 2].map((slot) => {
          const idx = (tick + slot) % FEED.length;
          return (
            <Box key={`${idx}-${slot}`} animation={slot === 2 && !reduced ? "fade-up" : undefined}>
              <HStack gap="2" opacity={slot === 0 ? 0.4 : slot === 1 ? 0.7 : 1}>
                <Box boxSize="5px" borderRadius="full" style={{ background: GREEN }} flexShrink={0} />
                <Text textStyle="data" fontSize="11px" color="fg" truncate>
                  {FEED[idx]}
                </Text>
              </HStack>
            </Box>
          );
        })}
      </Stack>
    </Tile>
  );
}

/* ------------------------------- T9 · pipeline ----------------------------- */

function PipelineTile({ reduced }: { reduced: boolean }) {
  const tick = useLoop(1000, !reduced);
  const step = reduced ? 5 : tick % 7;

  return (
    <Tile label="PIPELINE · END TO END" colSpan={{ md: 2, lg: 2 }}>
      <Flex
        flex="1"
        direction={{ base: "column", md: "row" }}
        align={{ base: "flex-start", md: "center" }}
        aria-hidden
      >
        {PIPELINE.map((s, i) => {
          const passed = i < step;
          const active = i === step && step < PIPELINE.length;
          return (
            <Flex
              key={s.key}
              direction={{ base: "column", md: "row" }}
              align={{ base: "flex-start", md: "center" }}
              flex={{ base: "none", md: i < PIPELINE.length - 1 ? "1" : "none" }}
              w={{ base: "auto", md: i < PIPELINE.length - 1 ? "full" : "auto" }}
            >
              <HStack gap="1.5" flexShrink={0}>
                <Box
                  boxSize="8px"
                  borderRadius="full"
                  transition="background 240ms ease, border-color 240ms ease"
                  style={{
                    background: passed ? GREEN : active ? ULTRA : "transparent",
                    border: passed || active ? "none" : `1.5px solid ${HAIRLINE_HOVER}`,
                  }}
                />
                <Text
                  textStyle="data"
                  fontSize="9.5px"
                  letterSpacing="0.08em"
                  textTransform="uppercase"
                  whiteSpace="nowrap"
                  transition="color 240ms ease"
                  style={{
                    color:
                      passed || active
                        ? "var(--chakra-colors-fg)"
                        : "var(--chakra-colors-fg-subtle)",
                  }}
                >
                  {s.title}
                </Text>
              </HStack>
              {i < PIPELINE.length - 1 && (
                <Box
                  flex={{ base: "none", md: "1" }}
                  w={{ base: "1px", md: "auto" }}
                  h={{ base: "12px", md: "1px" }}
                  ml={{ base: "3.5px", md: "2" }}
                  mr={{ base: "0", md: "2" }}
                  my={{ base: "1", md: "0" }}
                  transition="background 240ms ease"
                  style={{ background: i < step ? GREEN : HAIRLINE }}
                />
              )}
            </Flex>
          );
        })}
      </Flex>
    </Tile>
  );
}

/* ------------------------------- bento + stats ----------------------------- */

function BentoGrid({ reduced }: { reduced: boolean }) {
  return (
    <Box id="product" css={{ scrollMarginTop: "76px" }}>
      <Grid
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        templateColumns={{ base: "1fr", md: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" }}
        gridAutoRows={{ base: "auto", md: "160px" }}
        gap="3"
      >
        <MomentTile />
        <ScoreTile />
        <CaptionTile reduced={reduced} />
        <RatioTile />
        <PublishTile reduced={reduced} />
        <RepurposeTile reduced={reduced} />
        <DubTile reduced={reduced} />
        <AutopilotTile reduced={reduced} />
        <PipelineTile reduced={reduced} />
      </Grid>

      {/* stat strip — same mono voice as the tile labels */}
      <Flex
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        mt="8"
        justify="center"
        columnGap={{ base: "6", md: "10" }}
        rowGap="2"
        flexWrap="wrap"
        data-reveal
      >
        {STATS.map((s) => (
          <HStack key={s.label} gap="2">
            <Text textStyle="data" fontSize="12px" fontWeight="600" color="fg">
              {s.value.toLocaleString()}
            </Text>
            <Text textStyle="data" fontSize="10px" letterSpacing="0.1em" color="fg.subtle">
              {s.label.toUpperCase()}
            </Text>
          </HStack>
        ))}
      </Flex>
    </Box>
  );
}

/* -------------------------------- proof band ------------------------------- */

function ProofBand() {
  return (
    <Box mt={{ base: "16", md: "24" }} bg="bg.subtle" borderYWidth="1px" borderColor={HAIRLINE}>
      <Grid
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        templateColumns={{ base: "1fr", md: "repeat(3, 1fr)" }}
      >
        {PAIN_POINTS.slice(0, 3).map((p, i) => (
          <Stack
            key={p.quote}
            data-reveal
            py={{ base: "8", md: "12" }}
            px={{ base: "0", md: "8" }}
            pl={{ base: "0", md: i === 0 ? "0" : "8" }}
            gap="2.5"
            borderLeftWidth={{ base: "0", md: i > 0 ? "1px" : "0" }}
            borderTopWidth={{ base: i > 0 ? "1px" : "0", md: "0" }}
            borderColor={HAIRLINE}
          >
            <Text
              fontSize="13px"
              color="fg.subtle"
              textDecoration="line-through"
              textDecorationColor="border.emphasized"
            >
              “{p.quote}”
            </Text>
            <Text
              fontFamily="display"
              fontWeight="650"
              letterSpacing="-0.015em"
              fontSize="17px"
              color="fg"
            >
              {p.fix}
            </Text>
          </Stack>
        ))}
      </Grid>
    </Box>
  );
}

/* ------------------------------ workflow strip ------------------------------ */

const WORKFLOW_STEPS = [
  { n: "01", title: "Upload", body: "Drop a file or paste a link." },
  { n: "02", title: "Review scores", body: "Every moment rated 0–100." },
  { n: "03", title: "Publish everywhere", body: "Schedule to 5 platforms." },
] as const;

function WorkflowStrip() {
  return (
    <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }} py={{ base: "16", md: "24" }}>
      <Text
        as="h2"
        data-reveal
        fontFamily="display"
        fontWeight="700"
        letterSpacing="-0.03em"
        fontSize={{ base: "28px", md: "36px" }}
        color="fg"
        textAlign="center"
      >
        Three steps, not seven.
      </Text>

      <Flex
        mt={{ base: "10", md: "12" }}
        direction={{ base: "column", md: "row" }}
        align={{ base: "flex-start", md: "center" }}
        gap={{ base: "6", md: "0" }}
        data-reveal
      >
        {WORKFLOW_STEPS.map((s, i) => (
          <Flex
            key={s.n}
            align="center"
            flex={{ base: "none", md: i < WORKFLOW_STEPS.length - 1 ? "1" : "none" }}
            w={{ base: "full", md: "auto" }}
          >
            <Stack gap="1.5" flexShrink={0}>
              <Text textStyle="data" fontSize="11px" fontWeight="600" style={{ color: ULTRA }}>
                {s.n}
              </Text>
              <Text
                fontFamily="display"
                fontWeight="650"
                letterSpacing="-0.015em"
                fontSize="19px"
                color="fg"
              >
                {s.title}
              </Text>
              <Text fontSize="13px" color="fg.muted">
                {s.body}
              </Text>
            </Stack>
            {i < WORKFLOW_STEPS.length - 1 && (
              <Box
                display={{ base: "none", md: "block" }}
                flex="1"
                h="1px"
                bg={HAIRLINE}
                mx="8"
                aria-hidden
              />
            )}
          </Flex>
        ))}
      </Flex>

      <Text
        mt={{ base: "10", md: "12" }}
        textAlign="center"
        textStyle="data"
        fontSize="11px"
        letterSpacing="0.06em"
        color="fg.subtle"
        data-reveal
      >
        Competitors average 5–7 steps per clip. (Research pack, Feb 2026)
      </Text>
    </Box>
  );
}

/* --------------------------------- pricing --------------------------------- */

function PricingBento() {
  return (
    <Box
      id="pricing"
      maxW="1240px"
      mx="auto"
      px={{ base: "5", md: "10" }}
      pb={{ base: "16", md: "24" }}
      css={{ scrollMarginTop: "76px" }}
    >
      <Stack gap="3" align="center" textAlign="center" data-reveal>
        <Text
          as="h2"
          fontFamily="display"
          fontWeight="700"
          letterSpacing="-0.03em"
          fontSize={{ base: "28px", md: "36px" }}
          color="fg"
        >
          A minute in is a minute metered.
        </Text>
        <Text fontSize="14px" color="fg.muted" maxW="52ch">
          One honest metric: a minute of source media equals one processing minute. No credit math.
        </Text>
      </Stack>

      <Grid
        mt={{ base: "10", md: "12" }}
        templateColumns={{ base: "1fr", md: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" }}
        gap="3"
      >
        {TIERS.map((t) => (
          <Stack
            key={t.name}
            data-tile
            bg={TILE_BG}
            borderWidth={t.featured ? "2px" : "1px"}
            borderColor={t.featured ? ULTRA : HAIRLINE}
            borderRadius="16px"
            boxShadow={TILE_SHADOW}
            p="5"
            gap="4"
            transition="transform 200ms ease, border-color 200ms ease"
            _hover={t.featured ? { transform: "translateY(-2px)" } : TILE_HOVER}
          >
            <Flex justify="space-between" align="center" minH="18px">
              <Text fontFamily="display" fontWeight="650" fontSize="16px" color="fg">
                {t.name}
              </Text>
              {t.featured && (
                <Text
                  textStyle="data"
                  fontSize="9px"
                  letterSpacing="0.14em"
                  style={{ color: ULTRA }}
                >
                  MOST POPULAR
                </Text>
              )}
            </Flex>
            <HStack align="baseline" gap="1">
              <Text textStyle="data" fontSize="34px" fontWeight="600" color="fg" lineHeight="1">
                ${t.price}
              </Text>
              <Text textStyle="data" fontSize="11px" color="fg.subtle">
                /mo
              </Text>
            </HStack>
            <Text fontSize="12.5px" color="fg.muted">
              {t.blurb}
            </Text>
            <Stack gap="2" flex="1">
              {t.points.map((p) => (
                <HStack key={p} gap="2" align="flex-start">
                  <Box
                    mt="6px"
                    boxSize="5px"
                    borderRadius="full"
                    flexShrink={0}
                    style={{ background: t.featured ? ULTRA : HAIRLINE_HOVER }}
                  />
                  <Text fontSize="12.5px" color="fg.muted" lineHeight="1.5">
                    {p}
                  </Text>
                </HStack>
              ))}
            </Stack>
            {t.featured ? (
              <Button size="sm" w="full" asChild>
                <Link href="/sign-up">Start with {t.name}</Link>
              </Button>
            ) : (
              <Button variant="outline" size="sm" w="full" asChild>
                <Link href="/sign-up">{t.price === 0 ? "Start free" : `Choose ${t.name}`}</Link>
              </Button>
            )}
          </Stack>
        ))}
      </Grid>
    </Box>
  );
}

/* -------------------------------- final CTA -------------------------------- */

function FinalCta() {
  return (
    <Box borderTopWidth="1px" borderColor={HAIRLINE}>
      <Stack
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        py={{ base: "20", md: "32" }}
        align="center"
        textAlign="center"
        gap="7"
        data-reveal
      >
        <Text
          as="h2"
          fontFamily="display"
          fontWeight="700"
          letterSpacing="-0.03em"
          lineHeight="1.05"
          color="fg"
          maxW="16ch"
          css={{ fontSize: "clamp(34px, 4.6vw, 56px)" }}
        >
          Ship this week&apos;s posts today.
        </Text>
        <Button size="lg" px="8" asChild>
          <Link href="/sign-up">Start free</Link>
        </Button>
        <Text textStyle="data" fontSize="11px" letterSpacing="0.12em" color="fg.subtle">
          FREE PLAN · 60 MIN/MO · NO CARD
        </Text>
      </Stack>

      <Flex
        borderTopWidth="1px"
        borderColor={HAIRLINE}
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        py="5"
        justify="space-between"
        align="center"
        flexWrap="wrap"
        gap="3"
      >
        <Text textStyle="data" fontSize="11px" color="fg.subtle">
          © {new Date().getFullYear()} Narriflow
        </Text>
        <HStack gap="6">
          <Link href="/privacy">
            <Text
              fontSize="12px"
              color="fg.muted"
              _hover={{ color: "fg" }}
              transition="color 140ms ease"
            >
              Privacy
            </Text>
          </Link>
          <Link href="/terms">
            <Text
              fontSize="12px"
              color="fg.muted"
              _hover={{ color: "fg" }}
              transition="color 140ms ease"
            >
              Terms
            </Text>
          </Link>
        </HStack>
      </Flex>
    </Box>
  );
}

/* ----------------------------------- page ---------------------------------- */

const SCORE_STEPS = [
  { v: 92, row: 0 },
  { v: 87, row: 1 },
  { v: 81, row: 2 },
  { v: 74, row: -1 },
] as const;

const RATIO_STEPS = [
  { label: "1:1", w: 60, h: 60 },
  { label: "16:9", w: 96, h: 54 },
  { label: "4:5", w: 56, h: 70 },
  { label: "9:16", w: 40.5, h: 72 },
] as const;

export function SystemClient() {
  const rootRef = useRef<HTMLDivElement>(null);
  const reduced = usePrefersReducedMotion();

  useGSAP(
    () => {
      const root = rootRef.current;
      if (!root) return;
      const prefersReduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      const scoreEl = root.querySelector<HTMLElement>("[data-score-value]");
      const meterEl = root.querySelector<HTMLElement>("[data-score-meter]");
      const scoreRows = Array.from(root.querySelectorAll<HTMLElement>("[data-score-row]"));
      const frameEl = root.querySelector<HTMLElement>("[data-ratio-frame]");
      const ratioLabelEl = root.querySelector<HTMLElement>("[data-ratio-label]");
      const setActiveRow = (idx: number) => {
        for (const [i, row] of scoreRows.entries()) row.dataset.active = String(i === idx);
      };

      if (prefersReduced) {
        // Static states: everything visible, the "best" frame of each loop.
        gsap.set("[data-hero-el], [data-tile], [data-reveal]", { opacity: 1 });
        if (scoreEl) scoreEl.textContent = "92";
        if (meterEl) gsap.set(meterEl, { scaleY: 0.92 });
        setActiveRow(0);
        if (ratioLabelEl) ratioLabelEl.textContent = "9:16";
        return;
      }

      // Hero entrance — one quiet stagger.
      gsap.fromTo(
        "[data-hero-el]",
        { autoAlpha: 0, y: 16 },
        { autoAlpha: 1, y: 0, duration: 0.7, ease: "power3.out", stagger: 0.08 },
      );

      // Bento tiles — single staggered batch.
      gsap.set("[data-tile]", { autoAlpha: 0, y: 22 });
      ScrollTrigger.batch("[data-tile]", {
        start: "top 90%",
        once: true,
        onEnter: (els) =>
          gsap.to(els, { autoAlpha: 1, y: 0, duration: 0.7, ease: "power3.out", stagger: 0.07 }),
      });

      // Section reveals.
      for (const el of gsap.utils.toArray<HTMLElement>("[data-reveal]")) {
        gsap.fromTo(
          el,
          { autoAlpha: 0, y: 20 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.75,
            ease: "power3.out",
            scrollTrigger: { trigger: el, start: "top 88%" },
          },
        );
      }

      // T2 — virality score loop: number tween + meter + synced row highlight.
      if (scoreEl && meterEl) {
        const obj = { v: 74 };
        const tl = gsap.timeline({ repeat: -1 });
        for (const step of SCORE_STEPS) {
          tl.call(() => setActiveRow(step.row))
            .to(obj, {
              v: step.v,
              duration: 0.7,
              ease: "power2.inOut",
              snap: { v: 1 },
              onUpdate: () => {
                scoreEl.textContent = String(obj.v);
              },
            })
            .to(meterEl, { scaleY: step.v / 100, duration: 0.7, ease: "power2.inOut" }, "<")
            .to({}, { duration: 1.7 });
        }
      }

      // T4 — aspect-ratio frame morph.
      if (frameEl && ratioLabelEl) {
        const tl = gsap.timeline({
          repeat: -1,
          defaults: { duration: 0.55, ease: "power3.inOut" },
        });
        for (const step of RATIO_STEPS) {
          tl.to({}, { duration: 1.35 })
            .call(() => {
              ratioLabelEl.textContent = step.label;
            })
            .to(frameEl, { width: step.w, height: step.h });
        }
      }
    },
    { scope: rootRef },
  );

  return (
    <SmoothScroll>
      {/* System is a porcelain-light precision bento — pin light tokens
          regardless of the app color mode via Chakra's class condition. */}
      <Box ref={rootRef} className="light" bg="bg" color="fg" minH="100vh" overflowX="clip">
        <SystemNav />
        <Hero />
        <BentoGrid reduced={reduced} />
        <ProofBand />
        <WorkflowStrip />
        <PricingBento />
        <FinalCta />
        <VariantDial />
      </Box>
    </SmoothScroll>
  );
}
