"use client";

import { useRef } from "react";
import Link from "next/link";
import { Box, Flex, Grid, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { SmoothScroll } from "../../_components/smooth-scroll";
import { VariantDial } from "../../_components/variant-dial";
import { CAPTION_PRESETS, FEATURES, PIPELINE, TIERS } from "../../_components/landing-data";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
}

/* ------------------------------ studio palette ----------------------------- */
/* This page is deliberately mode-invariant studio chrome (see CLAUDE.md), so
 * literal graphite/cyan hexes are allowed here alongside the studio.* tokens. */

/* typed <video> with style props — `Box as="video"` drops the media attrs */
const Video = chakra("video");

const INK = "#0A0D2A"; // dark label on the ultramarine solid — never white
const ACCENT = "#5B6CFF";
const ACCENT_HOVER = "#7683FF";
const CYAN = "#7FD4E4";
const REC_RED = "#E5484D";

/* -------------------------------- session data ----------------------------- */

const SESSION_FRAMES = 12 * 60 * 24; // 00:12:00:00 @ 24fps

function formatTimecode(progress: number) {
  const fr = Math.round(Math.min(Math.max(progress, 0), 1) * SESSION_FRAMES);
  const pad = (n: number) => String(n).padStart(2, "0");
  const f = fr % 24;
  const s = Math.floor(fr / 24) % 60;
  const m = Math.floor(fr / (24 * 60)) % 60;
  const h = Math.floor(fr / (24 * 3600));
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

const CLIPS = [
  { name: "clip_01.mp4", tc: "00:04:12", dur: "0:34", score: 71, render: false },
  { name: "clip_02.mp4", tc: "00:09:48", dur: "0:41", score: 84, render: false },
  { name: "clip_03.mp4", tc: "00:12:41", dur: "0:28", score: 92, render: true },
  { name: "clip_04.mp4", tc: "00:19:27", dur: "0:52", score: 66, render: false },
  { name: "clip_05.mp4", tc: "00:26:33", dur: "0:37", score: 79, render: false },
  { name: "clip_06.mp4", tc: "00:31:05", dur: "0:44", score: 87, render: false },
  { name: "clip_07.mp4", tc: "00:44:56", dur: "0:31", score: 74, render: false },
] as const;

/* deterministic pseudo-waveform so SSR and client render identical bars */
const WAVES = CLIPS.map((_, c) =>
  Array.from({ length: 26 }, (_, i) => 0.22 + 0.78 * Math.abs(Math.sin(c * 3.7 + i * 1.31))),
);

const RACK_META: Record<(typeof FEATURES)[number]["key"], string> = {
  moments: "SCORE 0–100",
  captions: "12 PRESETS · 9 STYLES",
  ratios: "9:16 · 1:1 · 16:9 · 4:5",
  reframe: "SPEAKER-TRACKED",
  repurpose: "5 FORMATS",
  publish: "5 PLATFORMS",
  dubbing: "MULTI-LANG",
  autopilot: "RSS FEED IN",
};

const ANIMATION_STYLES = [
  "none",
  "word-by-word",
  "karaoke",
  "bounce",
  "blur-in",
  "grow",
  "breathe",
  "soft-landing",
  "glitch",
] as const;

const MOMENTS = [
  { tc: "00:12:41", score: 92, render: true },
  { tc: "00:31:05", score: 87, render: false },
  { tc: "00:44:56", score: 74, render: false },
] as const;

/* --------------------------------- helpers -------------------------------- */

function CornerBrackets({ color = "studio.fg" }: { color?: string }) {
  return (
    <>
      {[
        { top: "-9px", left: "-9px", borderTopWidth: "1.5px", borderLeftWidth: "1.5px" },
        { top: "-9px", right: "-9px", borderTopWidth: "1.5px", borderRightWidth: "1.5px" },
        { bottom: "-9px", left: "-9px", borderBottomWidth: "1.5px", borderLeftWidth: "1.5px" },
        { bottom: "-9px", right: "-9px", borderBottomWidth: "1.5px", borderRightWidth: "1.5px" },
      ].map((pos, i) => (
        <Box key={i} position="absolute" boxSize="24px" borderColor={color} {...pos} aria-hidden />
      ))}
    </>
  );
}

function SectionHeading({
  eyebrow,
  title,
  children,
}: {
  eyebrow: string;
  title: string;
  children?: React.ReactNode;
}) {
  return (
    <Stack gap="3" maxW="640px" data-reveal style={{ opacity: 0 }}>
      <HStack gap="3">
        <Box boxSize="7px" bg={ACCENT} aria-hidden />
        <Text textStyle="data" fontSize="11px" letterSpacing="0.18em" color="studio.fgSubtle">
          {eyebrow}
        </Text>
      </HStack>
      <Text
        as="h2"
        fontFamily="display"
        fontWeight="700"
        letterSpacing="-0.03em"
        lineHeight="1.06"
        fontSize={{ base: "30px", md: "44px" }}
        color="studio.fg"
      >
        {title}
      </Text>
      {children}
    </Stack>
  );
}

/* ----------------------------- transport-bar nav --------------------------- */

function TransportNav() {
  return (
    <Flex
      as="header"
      position="fixed"
      top="0"
      insetX="0"
      zIndex="60"
      h="56px"
      px={{ base: "4", md: "8" }}
      align="center"
      justify="space-between"
      borderBottomWidth="1px"
      borderColor="studio.border"
      bg="rgba(14, 16, 19, 0.86)"
      backdropFilter="blur(14px) saturate(1.2)"
    >
      {/* the Logo inks itself with the `fg` token; pin it light on studio chrome */}
      <Box css={{ "--chakra-colors-fg": "#E9EBEE", "--chakra-colors-accent-solid": ACCENT }}>
        <Link href="/" aria-label="Narriflow home">
          <Logo size="md" />
        </Link>
      </Box>

      <HStack
        gap="2.5"
        position="absolute"
        left="50%"
        transform="translateX(-50%)"
        display={{ base: "none", md: "flex" }}
        aria-hidden
      >
        <Text
          textStyle="data"
          fontSize="10px"
          letterSpacing="0.2em"
          color="studio.fgSubtle"
          display={{ base: "none", sm: "block" }}
        >
          SESSION
        </Text>
        <Text
          data-session-timecode
          textStyle="data"
          fontSize={{ base: "12px", md: "13px" }}
          letterSpacing="0.08em"
          color="studio.timecode"
        >
          00:00:00:00
        </Text>
      </HStack>

      <Button
        variant="outline"
        size="sm"
        borderColor="studio.borderControl"
        color="studio.fg"
        _hover={{ bg: "studio.surface" }}
        asChild
      >
        <Link href="/sign-up">Open project →</Link>
      </Button>

      {/* scroll-progress rule along the bottom edge */}
      <Box position="absolute" bottom="-1px" insetX="0" h="2px" overflow="hidden" aria-hidden>
        <Box
          data-scroll-progress
          h="full"
          w="full"
          bg={ACCENT}
          transformOrigin="left"
          style={{ transform: "scaleX(0)" }}
        />
      </Box>
    </Flex>
  );
}

/* ----------------------------------- hero ---------------------------------- */

function Hero() {
  const pipelineReadout = PIPELINE.map((p) => p.title.toUpperCase()).join(" / ");

  return (
    <Box position="relative" pt={{ base: "108px", md: "132px" }} pb={{ base: "16", md: "24" }} overflow="hidden">
      {/* ambient monitor glow */}
      <Box
        position="absolute"
        inset="0"
        css={{
          background:
            "radial-gradient(900px 480px at 50% 78%, rgba(91,108,255,0.10), transparent 65%)",
        }}
        aria-hidden
      />

      <Box position="relative" maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <HStack gap="3" data-hero-eyebrow style={{ opacity: 0 }}>
          <Box boxSize="7px" bg={REC_RED} borderRadius="full" data-rec-dot aria-hidden />
          <Text textStyle="data" fontSize="11px" letterSpacing="0.2em" color="studio.fgMuted">
            SESSION 001 — AI PASS ARMED
          </Text>
        </HStack>

        <Box
          as="h1"
          mt="6"
          fontFamily="display"
          fontWeight="700"
          letterSpacing="-0.03em"
          lineHeight="1.02"
          fontSize={{ base: "42px", md: "74px", lg: "94px" }}
          color="studio.fg"
          maxW="14ch"
        >
          {"The editor that edits itself.".split(" ").map((word, i) => (
            <Box
              as="span"
              key={i}
              display="inline-block"
              overflow="hidden"
              verticalAlign="top"
              mr="0.24em"
            >
              <Box as="span" display="inline-block" data-hero-word style={{ opacity: 0 }}>
                {word === "itself." ? (
                  <Box as="span" color="studio.accentFg">
                    {word}
                  </Box>
                ) : (
                  word
                )}
              </Box>
            </Box>
          ))}
        </Box>

        <Text
          mt="6"
          data-hero-sub
          style={{ opacity: 0 }}
          textStyle="data"
          fontSize={{ base: "11px", md: "13px" }}
          letterSpacing="0.12em"
          color="studio.fgMuted"
        >
          LONG-FORM IN → SCORED CLIPS OUT · {pipelineReadout}
        </Text>

        <HStack mt="8" gap="3" flexWrap="wrap" data-hero-cta style={{ opacity: 0 }}>
          <Button size="lg" px="7" bg={ACCENT} color={INK} _hover={{ bg: ACCENT_HOVER }} asChild>
            <Link href="/sign-up">Start cutting — free</Link>
          </Button>
          <Button
            variant="ghost"
            size="lg"
            color="studio.fgMuted"
            _hover={{ bg: "studio.surface", color: "studio.fg" }}
            asChild
          >
            <Link href="#timeline">Scrub the timeline ↓</Link>
          </Button>
        </HStack>

        {/* program monitor */}
        <Box position="relative" mt={{ base: "12", md: "16" }} data-hero-video style={{ opacity: 0 }}>
          <CornerBrackets />
          <Box
            bg="studio.subtle"
            borderWidth="1px"
            borderColor="studio.borderStrong"
            borderRadius="l3"
            p={{ base: "2", md: "3" }}
            position="relative"
            overflow="hidden"
          >
            <Video
              src="/videos/moment-detect.mp4"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              w="full"
              display="block"
              borderRadius="l2"
            />
            {/* live overlay chip */}
            <Flex
              position="absolute"
              top={{ base: "4", md: "6" }}
              left={{ base: "4", md: "6" }}
              align="center"
              gap="2"
              px="3"
              py="1.5"
              bg="rgba(14, 16, 19, 0.78)"
              backdropFilter="blur(8px)"
              borderWidth="1px"
              borderColor="studio.border"
              borderRadius="l1"
              aria-hidden
            >
              <Box boxSize="7px" bg={REC_RED} borderRadius="full" data-rec-dot />
              <Text textStyle="data" fontSize="10px" letterSpacing="0.16em" color="studio.fg">
                AI PASS · RUNNING
              </Text>
            </Flex>
          </Box>

          <Flex mt="3" gap="2" flexWrap="wrap" align="center" justify="space-between">
            <HStack gap="2" flexWrap="wrap">
              {[
                ["SRC", "47:12"],
                ["CLIPS", "06"],
                ["BEST", "92"],
              ].map(([k, v]) => (
                <HStack
                  key={k}
                  data-hero-readout
                  style={{ opacity: 0 }}
                  gap="2"
                  px="3"
                  py="1.5"
                  bg="studio.surface"
                  borderWidth="1px"
                  borderColor="studio.border"
                  borderRadius="l1"
                >
                  <Text textStyle="data" fontSize="10px" letterSpacing="0.14em" color="studio.fgSubtle">
                    {k}
                  </Text>
                  <Text textStyle="data" fontSize="12px" color="studio.timecode">
                    {v}
                  </Text>
                </HStack>
              ))}
            </HStack>
            <Text
              data-hero-readout
              style={{ opacity: 0 }}
              textStyle="data"
              fontSize="11px"
              color="studio.fgSubtle"
            >
              PGM 01 — MOMENT DETECTION
            </Text>
          </Flex>
        </Box>
      </Box>
    </Box>
  );
}

/* ------------------------- timeline strip (pinned scrub) -------------------- */

function TimelineScrub() {
  return (
    <Box
      id="timeline"
      data-scrub-section
      position="relative"
      borderTopWidth="1px"
      borderColor="studio.border"
      css={{ scrollMarginTop: "56px" }}
    >
      <Box
        data-scrub-pin
        minH="100vh"
        display="flex"
        flexDirection="column"
        justifyContent="center"
        py={{ base: "16", md: "10" }}
        overflow="hidden"
      >
        <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }} w="full">
          <SectionHeading eyebrow="TIMELINE — SRC 47:12" title="Scroll to scrub. We already found the cuts.">
            <Text fontSize="15px" color="studio.fgMuted" lineHeight="1.7" maxW="52ch">
              Moment detection reads the whole transcript, marks the clip-worthy segments and
              scores each one 0–100. The timeline arrives pre-cut.
            </Text>
          </SectionHeading>
        </Box>

        <Box position="relative" mt={{ base: "10", md: "14" }}>
          {/* fixed playhead over the moving track */}
          <Box
            position="absolute"
            left="50%"
            top="-12px"
            bottom="-12px"
            w="2px"
            bg={CYAN}
            boxShadow={`0 0 14px ${CYAN}, 0 0 42px rgba(127,212,228,0.35)`}
            zIndex="2"
            display={{ base: "none", md: "block" }}
            aria-hidden
          >
            <Box
              position="absolute"
              top="-7px"
              left="50%"
              transform="translateX(-50%)"
              css={{
                width: 0,
                height: 0,
                borderLeft: "6px solid transparent",
                borderRight: "6px solid transparent",
                borderTop: `7px solid ${CYAN}`,
              }}
            />
          </Box>

          <Box
            data-scrub-scroller
            overflowX={{ base: "auto", md: "hidden" }}
            css={{ scrollbarWidth: "thin", scrollbarColor: "#303845 transparent" }}
          >
            <Box data-scrub-track w="max-content" pl={{ base: "5", md: "10vw" }} pr={{ base: "5", md: "55vw" }}>
              {/* ruler */}
              <Flex mb="4" aria-hidden>
                {Array.from({ length: 56 }, (_, i) => {
                  const secs = Math.round((i / 56) * (47 * 60 + 12));
                  const label = `${String(Math.floor(secs / 60)).padStart(2, "0")}:${String(secs % 60).padStart(2, "0")}`;
                  return (
                    <Box key={i} w="52px" flexShrink={0} position="relative">
                      <Box
                        h={i % 4 === 0 ? "14px" : "7px"}
                        borderLeftWidth="1px"
                        borderColor={i % 4 === 0 ? "studio.borderControl" : "studio.borderStrong"}
                      />
                      {i % 4 === 0 && (
                        <Text
                          position="absolute"
                          top="16px"
                          left="0"
                          textStyle="data"
                          fontSize="9px"
                          letterSpacing="0.08em"
                          color="studio.fgSubtle"
                        >
                          {label}
                        </Text>
                      )}
                    </Box>
                  );
                })}
              </Flex>

              {/* clip segments */}
              <Flex gap="4" pt="6" pb="2">
                {CLIPS.map((clip, ci) => (
                  <Stack
                    key={clip.name}
                    data-clip-card
                    w={{ base: "230px", md: "280px" }}
                    flexShrink={0}
                    gap="3"
                    p="4"
                    bg="studio.subtle"
                    borderWidth={clip.render ? "1.5px" : "1px"}
                    borderColor={clip.render ? ACCENT : "studio.border"}
                    borderRadius="l2"
                    transition="border-color 200ms ease, background 200ms ease, box-shadow 200ms ease"
                    css={{
                      "&.is-live": {
                        background: "var(--chakra-colors-studio-surface)",
                        borderColor: clip.render ? ACCENT : CYAN,
                        boxShadow: clip.render
                          ? "0 0 28px rgba(91,108,255,0.22)"
                          : "0 0 24px rgba(127,212,228,0.14)",
                      },
                      "&.is-live [data-wave-bar]": {
                        background: CYAN,
                        opacity: 0.9,
                      },
                    }}
                  >
                    <Flex justify="space-between" align="baseline" gap="2">
                      <Text textStyle="data" fontSize="12px" color="studio.fg">
                        {clip.name}
                      </Text>
                      <Text textStyle="data" fontSize="11px" color="studio.fgSubtle">
                        {clip.dur}
                      </Text>
                    </Flex>

                    {/* mini waveform */}
                    <Flex align="flex-end" gap="2px" h="44px" aria-hidden>
                      {(WAVES[ci] ?? []).map((h, i) => (
                        <Box
                          key={i}
                          data-wave-bar
                          flex="1"
                          bg="studio.fgSubtle"
                          opacity="0.45"
                          borderRadius="1px"
                          transition="background 200ms ease, opacity 200ms ease"
                          style={{ height: `${Math.round(h * 100)}%` }}
                        />
                      ))}
                    </Flex>

                    <Flex justify="space-between" align="center">
                      <Text textStyle="data" fontSize="11px" color="studio.timecode">
                        IN {clip.tc}
                      </Text>
                      <HStack gap="2">
                        {clip.render && (
                          <Text
                            textStyle="data"
                            fontSize="9px"
                            letterSpacing="0.16em"
                            px="2"
                            py="0.5"
                            bg={ACCENT}
                            color={INK}
                            borderRadius="l1"
                            fontWeight="700"
                          >
                            RENDER
                          </Text>
                        )}
                        <Text
                          textStyle="data"
                          fontSize="12px"
                          fontWeight="600"
                          px="2"
                          py="0.5"
                          borderWidth="1px"
                          borderColor={clip.render ? ACCENT : "studio.borderStrong"}
                          borderRadius="l1"
                          color={clip.render ? "studio.accentFg" : "studio.fgMuted"}
                        >
                          {clip.score}
                        </Text>
                      </HStack>
                    </Flex>
                  </Stack>
                ))}
              </Flex>
            </Box>
          </Box>
        </Box>

        <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }} w="full" mt={{ base: "8", md: "10" }}>
          <Text textStyle="data" fontSize="11px" letterSpacing="0.14em" color="studio.fgSubtle">
            07 SEGMENTS DETECTED · HIGHEST 92 · SCRUB TO REVIEW
          </Text>
        </Box>
      </Box>
    </Box>
  );
}

/* --------------------------- rack — channel strips -------------------------- */

function Rack() {
  return (
    <Box borderTopWidth="1px" borderColor="studio.border" py={{ base: "20", md: "28" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <SectionHeading eyebrow="THE RACK" title="Every module, already patched in." />

        <Stack mt={{ base: "10", md: "14" }} gap="0">
          {FEATURES.map((f, i) => (
            <Flex
              key={f.key}
              data-reveal
              style={{ opacity: 0 }}
              role="group"
              py={{ base: "5", md: "6" }}
              px={{ base: "3", md: "5" }}
              gap={{ base: "4", md: "8" }}
              align={{ base: "flex-start", md: "center" }}
              direction={{ base: "column", md: "row" }}
              borderTopWidth="1px"
              borderColor="studio.border"
              _last={{ borderBottomWidth: "1px" }}
              transition="background 200ms ease"
              _hover={{ bg: "studio.surface" }}
            >
              <HStack gap="4" w={{ base: "auto", md: "110px" }} flexShrink={0}>
                <Box
                  data-led
                  boxSize="8px"
                  borderRadius="full"
                  bg="studio.raised"
                  transition="box-shadow 200ms ease"
                  _groupHover={{ boxShadow: `0 0 14px ${ACCENT}` }}
                  aria-hidden
                />
                <Text textStyle="data" fontSize="12px" color="studio.fgSubtle">
                  CH {String(i + 1).padStart(2, "0")}
                </Text>
              </HStack>

              <Box flex="1">
                <Text
                  as="h3"
                  fontFamily="display"
                  fontWeight="650"
                  letterSpacing="-0.015em"
                  fontSize={{ base: "19px", md: "22px" }}
                  color="studio.fg"
                >
                  {f.title}
                </Text>
                <Text mt="1.5" fontSize="14px" color="studio.fgMuted" lineHeight="1.65" maxW="62ch">
                  {f.body}
                </Text>
              </Box>

              <Text
                textStyle="data"
                fontSize="11px"
                letterSpacing="0.12em"
                color="studio.fgSubtle"
                flexShrink={0}
                _groupHover={{ color: "studio.timecode" }}
                transition="color 200ms ease"
              >
                {RACK_META[f.key]}
              </Text>
            </Flex>
          ))}
        </Stack>
      </Box>
    </Box>
  );
}

/* ------------------------------ caption monitor ----------------------------- */

function CaptionMonitor() {
  return (
    <Box bg="studio.subtle" borderYWidth="1px" borderColor="studio.border" py={{ base: "20", md: "28" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <Grid
          templateColumns={{ base: "1fr", lg: "380px 1fr" }}
          gap={{ base: "12", lg: "20" }}
          alignItems="center"
        >
          {/* broadcast monitor */}
          <Box data-reveal style={{ opacity: 0 }} justifySelf={{ base: "center", lg: "start" }} w={{ base: "270px", md: "320px" }}>
            <Box position="relative">
              <CornerBrackets color="studio.timecode" />
              <Box
                bg="studio.canvas"
                borderWidth="1px"
                borderColor="studio.borderStrong"
                borderRadius="l2"
                p="2.5"
                position="relative"
                overflow="hidden"
              >
                <Video
                  src="/videos/caption-loop.mp4"
                  autoPlay
                  muted
                  loop
                  playsInline
                  preload="metadata"
                  w="full"
                  display="block"
                  borderRadius="l1"
                />
                {/* scanlines */}
                <Box
                  position="absolute"
                  inset="2.5"
                  pointerEvents="none"
                  borderRadius="l1"
                  css={{
                    background:
                      "repeating-linear-gradient(0deg, rgba(255,255,255,0.028) 0px, rgba(255,255,255,0.028) 1px, transparent 1px, transparent 3px)",
                  }}
                  aria-hidden
                />
                <Text
                  position="absolute"
                  top="4"
                  right="5"
                  textStyle="data"
                  fontSize="10px"
                  letterSpacing="0.2em"
                  color="studio.timecode"
                  aria-hidden
                >
                  PGM
                </Text>
              </Box>
            </Box>
            <Flex mt="3" justify="space-between">
              <Text textStyle="data" fontSize="11px" color="studio.fgSubtle">
                MON 02 — CAPTION BURN-IN
              </Text>
              <Text textStyle="data" fontSize="11px" color="studio.timecode">
                9:16
              </Text>
            </Flex>
          </Box>

          <Stack gap="8">
            <SectionHeading eyebrow="CAPTION ENGINE" title="Captions locked to the waveform.">
              <Text fontSize="15px" color="studio.fgMuted" lineHeight="1.7" maxW="52ch">
                One cue model drives the editor preview and the final burn-in — the preview is the
                export, word for word. Twelve presets, nine animation styles, emoji captions.
              </Text>
            </SectionHeading>

            <Flex gap="2" flexWrap="wrap" data-reveal style={{ opacity: 0 }}>
              {CAPTION_PRESETS.map((p) => (
                <HStack
                  key={p.name}
                  gap="2"
                  px="3"
                  py="2"
                  bg="studio.surface"
                  borderWidth="1px"
                  borderColor="studio.borderStrong"
                  borderRadius="l1"
                  cursor="default"
                  transition="border-color 160ms ease, box-shadow 160ms ease, transform 160ms ease"
                  css={{
                    "&:hover": {
                      borderColor: p.accent,
                      boxShadow: `0 0 18px ${p.accent}44`,
                      transform: "translateY(-1px)",
                    },
                  }}
                >
                  <Box boxSize="7px" borderRadius="full" style={{ background: p.accent }} aria-hidden />
                  <Text textStyle="data" fontSize="12px" color="studio.fg">
                    {p.name}
                  </Text>
                </HStack>
              ))}
            </Flex>

            <Box data-reveal style={{ opacity: 0 }}>
              <Text textStyle="data" fontSize="10px" letterSpacing="0.18em" color="studio.fgSubtle" mb="2.5">
                ANIMATION STYLES
              </Text>
              <Flex gap="2" rowGap="2" flexWrap="wrap" align="center">
                {ANIMATION_STYLES.map((s, i) => (
                  <HStack key={s} gap="2">
                    <Text textStyle="data" fontSize="12px" color="studio.fgMuted">
                      {s}
                    </Text>
                    {i < ANIMATION_STYLES.length - 1 && (
                      <Text textStyle="data" fontSize="12px" color="studio.fgSubtle" aria-hidden>
                        ·
                      </Text>
                    )}
                  </HStack>
                ))}
              </Flex>
            </Box>
          </Stack>
        </Grid>
      </Box>
    </Box>
  );
}

/* -------------------------------- score meter ------------------------------- */

function ScoreMeter() {
  return (
    <Box data-score-section py={{ base: "20", md: "28" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <SectionHeading eyebrow="VIRALITY SCORING" title="Render the winners. Archive the rest." />

        <Grid
          mt={{ base: "10", md: "16" }}
          templateColumns={{ base: "1fr", lg: "auto 1fr" }}
          gap={{ base: "10", lg: "20" }}
          alignItems="center"
        >
          <Box>
            <Text
              data-score-count
              textStyle="data"
              fontWeight="600"
              lineHeight="0.9"
              letterSpacing="-0.04em"
              fontSize={{ base: "110px", md: "180px" }}
              color="studio.fg"
              aria-label="Top virality score: 92 out of 100"
            >
              0
            </Text>
            <Text mt="2" textStyle="data" fontSize="11px" letterSpacing="0.16em" color="studio.fgSubtle">
              TOP MOMENT / 100
            </Text>
            <Box mt="5" h="6px" bg="studio.raised" borderRadius="full" overflow="hidden" maxW="360px">
              <Box
                data-score-meter
                h="full"
                w="full"
                bg={ACCENT}
                transformOrigin="left"
                borderRadius="full"
                style={{ transform: "scaleX(0)" }}
                aria-hidden
              />
            </Box>
          </Box>

          <Stack gap="0">
            {MOMENTS.map((m) => (
              <Flex
                key={m.tc}
                data-reveal
                style={{ opacity: 0 }}
                py="5"
                gap={{ base: "4", md: "8" }}
                align="center"
                borderTopWidth="1px"
                borderColor="studio.border"
                _last={{ borderBottomWidth: "1px" }}
              >
                <Text textStyle="data" fontSize={{ base: "12px", md: "14px" }} color="studio.timecode" flexShrink={0}>
                  {m.tc}
                </Text>
                <Box flex="1" h="4px" bg="studio.raised" borderRadius="full" overflow="hidden">
                  <Box
                    data-moment-bar
                    data-score={m.score}
                    h="full"
                    w="full"
                    bg={m.render ? ACCENT : "studio.fgSubtle"}
                    transformOrigin="left"
                    borderRadius="full"
                    style={{ transform: "scaleX(0)" }}
                    aria-hidden
                  />
                </Box>
                <Text
                  textStyle="data"
                  fontSize={{ base: "14px", md: "16px" }}
                  fontWeight="600"
                  color={m.render ? "studio.accentFg" : "studio.fg"}
                  w="9"
                  textAlign="right"
                  flexShrink={0}
                >
                  {m.score}
                </Text>
                <Text
                  textStyle="data"
                  fontSize="9px"
                  letterSpacing="0.16em"
                  px="2"
                  py="0.5"
                  borderRadius="l1"
                  fontWeight="700"
                  bg={m.render ? ACCENT : "transparent"}
                  color={m.render ? INK : "studio.fgSubtle"}
                  borderWidth={m.render ? "0" : "1px"}
                  borderColor="studio.borderStrong"
                  flexShrink={0}
                >
                  {m.render ? "RENDER" : "ARCHIVE"}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Grid>
      </Box>
    </Box>
  );
}

/* ----------------------------- export queue pricing -------------------------- */

function ExportQueue() {
  return (
    <Box bg="studio.subtle" borderYWidth="1px" borderColor="studio.border" py={{ base: "20", md: "28" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <Flex justify="space-between" align="flex-end" gap="8" flexWrap="wrap">
          <SectionHeading eyebrow="EXPORT QUEUE" title="Pick your render budget." />
          <Text
            data-reveal
            style={{ opacity: 0 }}
            fontSize="14px"
            color="studio.fgMuted"
            maxW="34ch"
            lineHeight="1.65"
          >
            One honest metric: a minute of source media equals one processing minute. No credit math.
          </Text>
        </Flex>

        <Stack mt={{ base: "10", md: "14" }} gap="0" borderWidth="1px" borderColor="studio.borderStrong" bg="studio.canvas">
          {TIERS.map((t, i) => (
            <Flex
              key={t.name}
              data-reveal
              style={{ opacity: 0 }}
              position="relative"
              direction={{ base: "column", lg: "row" }}
              align={{ base: "flex-start", lg: "center" }}
              gap={{ base: "4", lg: "8" }}
              px={{ base: "5", md: "8" }}
              py={{ base: "6", md: "7" }}
              borderTopWidth={i > 0 ? "1px" : "0"}
              borderColor="studio.border"
              bg={t.featured ? "studio.surface" : "transparent"}
              transition="background 200ms ease"
              _hover={{ bg: "studio.surface" }}
            >
              {t.featured && (
                <Box position="absolute" left="0" insetY="0" w="3px" bg={ACCENT} aria-hidden />
              )}

              <HStack gap="5" w={{ base: "auto", lg: "230px" }} flexShrink={0}>
                <Text textStyle="data" fontSize="11px" letterSpacing="0.14em" color="studio.fgSubtle">
                  JOB {String(i + 1).padStart(2, "0")}
                </Text>
                <Box>
                  <Text
                    as="h3"
                    fontFamily="display"
                    fontWeight="650"
                    fontSize="20px"
                    letterSpacing="-0.015em"
                    color="studio.fg"
                  >
                    {t.name}
                  </Text>
                  <Text fontSize="12.5px" color="studio.fgMuted">
                    {t.blurb}
                  </Text>
                </Box>
              </HStack>

              <Text
                flex="1"
                textStyle="data"
                fontSize="11.5px"
                letterSpacing="0.04em"
                lineHeight="1.8"
                color="studio.fgMuted"
                display={{ base: "none", md: "block" }}
              >
                {t.points.join("  ·  ")}
              </Text>

              <HStack gap={{ base: "5", lg: "8" }} flexShrink={0} w={{ base: "full", lg: "auto" }} justify={{ base: "space-between", lg: "flex-end" }}>
                <Box textAlign={{ base: "left", lg: "right" }}>
                  <HStack gap="1" align="baseline" justify={{ base: "flex-start", lg: "flex-end" }}>
                    <Text textStyle="data" fontSize="28px" fontWeight="600" color="studio.fg">
                      ${t.price}
                    </Text>
                    <Text textStyle="data" fontSize="11px" color="studio.fgSubtle">
                      /MO
                    </Text>
                  </HStack>
                  <Text textStyle="data" fontSize="10.5px" letterSpacing="0.1em" color="studio.timecode">
                    {t.minutes.toLocaleString()} MIN/MO
                  </Text>
                </Box>
                {t.featured ? (
                  <Button size="sm" bg={ACCENT} color={INK} _hover={{ bg: ACCENT_HOVER }} asChild>
                    <Link href="/sign-up">Queue {t.name}</Link>
                  </Button>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    borderColor="studio.borderControl"
                    color="studio.fg"
                    _hover={{ bg: "studio.raised" }}
                    asChild
                  >
                    <Link href="/sign-up">{t.price === 0 ? "Start free" : `Choose ${t.name}`}</Link>
                  </Button>
                )}
              </HStack>
            </Flex>
          ))}
        </Stack>
      </Box>
    </Box>
  );
}

/* -------------------------------- closing CTA ------------------------------- */

const RULER_LINE = "|''''".repeat(120);

function ClosingCta() {
  return (
    <Box bg="#0A0B0D" position="relative" overflow="hidden">
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }} py={{ base: "24", md: "36" }}>
        <Grid templateColumns={{ base: "1fr", lg: "1fr 360px" }} gap={{ base: "14", lg: "24" }} alignItems="center">
          <Stack gap="8" align="flex-start" data-reveal style={{ opacity: 0 }}>
            <Text textStyle="data" fontSize="11px" letterSpacing="0.2em" color="studio.fgSubtle">
              SESSION END · 00:12:00:00 · FREE PLAN, NO CARD
            </Text>
            <Text
              as="h2"
              fontFamily="display"
              fontWeight="700"
              letterSpacing="-0.035em"
              lineHeight="1.04"
              fontSize={{ base: "40px", md: "64px" }}
              color="studio.fg"
              maxW="14ch"
            >
              Export your first clip tonight.
            </Text>
            <Button size="lg" px="8" bg={ACCENT} color={INK} _hover={{ bg: ACCENT_HOVER }} asChild>
              <Link href="/sign-up">Start cutting — free</Link>
            </Button>
          </Stack>

          <Box data-reveal style={{ opacity: 0 }} justifySelf={{ base: "start", lg: "end" }} w={{ base: "full", sm: "360px" }}>
            <Box
              bg="studio.subtle"
              borderWidth="1px"
              borderColor="studio.borderStrong"
              borderRadius="l2"
              p="2.5"
              boxShadow="0 30px 80px rgba(0,0,0,0.55)"
            >
              <Video
                src="/videos/repurpose-burst.mp4"
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                w="full"
                display="block"
                borderRadius="l1"
              />
            </Box>
            <Text mt="3" textStyle="data" fontSize="11px" color="studio.fgSubtle">
              OUT 04 — ONE SOURCE, EVERY FORMAT
            </Text>
          </Box>
        </Grid>
      </Box>

      <Flex
        borderTopWidth="1px"
        borderColor="studio.border"
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        py="5"
        justify="space-between"
        align="center"
        flexWrap="wrap"
        gap="3"
      >
        <Text textStyle="data" fontSize="11px" letterSpacing="0.14em" color="studio.fgSubtle">
          © {new Date().getFullYear()} NARRIFLOW
        </Text>
        <HStack gap="6">
          <Link href="/privacy">
            <Text
              fontSize="12px"
              color="studio.fgMuted"
              _hover={{ color: "studio.fg" }}
              transition="color 140ms ease"
            >
              Privacy
            </Text>
          </Link>
          <Link href="/terms">
            <Text
              fontSize="12px"
              color="studio.fgMuted"
              _hover={{ color: "studio.fg" }}
              transition="color 140ms ease"
            >
              Terms
            </Text>
          </Link>
        </HStack>
      </Flex>

      {/* final timeline ruler */}
      <Box overflow="hidden" px="0" pb="4" aria-hidden>
        <Text
          textStyle="data"
          fontSize="10px"
          lineHeight="1"
          color="studio.borderControl"
          whiteSpace="nowrap"
          userSelect="none"
        >
          {RULER_LINE}
        </Text>
      </Box>
    </Box>
  );
}

/* ----------------------------------- page ----------------------------------- */

export function StudioClient() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      const isMobile = window.matchMedia("(max-width: 767px)").matches;
      const track = document.querySelector<HTMLElement>("[data-scrub-track]");
      const scroller = document.querySelector<HTMLElement>("[data-scrub-scroller]");
      const cards = gsap.utils.toArray<HTMLElement>("[data-clip-card]");
      const scoreEl = document.querySelector<HTMLElement>("[data-score-count]");
      const momentBars = gsap.utils.toArray<HTMLElement>("[data-moment-bar]");

      if (reduced) {
        gsap.set(
          "[data-hero-eyebrow], [data-hero-word], [data-hero-sub], [data-hero-cta], [data-hero-video], [data-hero-readout], [data-reveal]",
          { opacity: 1 },
        );
        // pinned scrub degrades to a plain horizontal-overflow strip
        if (scroller) gsap.set(scroller, { overflowX: "auto" });
        gsap.set("[data-led]", { backgroundColor: ACCENT, boxShadow: `0 0 10px ${ACCENT}` });
        if (scoreEl) scoreEl.textContent = "92";
        gsap.set("[data-score-meter]", { scaleX: 0.92 });
        momentBars.forEach((bar) => {
          gsap.set(bar, { scaleX: Number(bar.dataset.score ?? 0) / 100 });
        });
        return;
      }

      /* session timecode + nav progress rule, driven by whole-page scroll */
      const timecodeEl = document.querySelector<HTMLElement>("[data-session-timecode]");
      const progressEl = document.querySelector<HTMLElement>("[data-scroll-progress]");
      ScrollTrigger.create({
        start: 0,
        end: "max",
        onUpdate(self) {
          if (timecodeEl) timecodeEl.textContent = formatTimecode(self.progress);
          if (progressEl) gsap.set(progressEl, { scaleX: self.progress });
        },
      });

      /* hero entrance */
      gsap
        .timeline({ defaults: { ease: "power3.out" } })
        .fromTo("[data-hero-eyebrow]", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6 })
        .fromTo(
          "[data-hero-word]",
          { opacity: 0, yPercent: 110 },
          { opacity: 1, yPercent: 0, duration: 0.9, stagger: 0.06 },
          0.1,
        )
        .fromTo("[data-hero-sub]", { opacity: 0, y: 16 }, { opacity: 1, y: 0, duration: 0.7 }, 0.55)
        .fromTo("[data-hero-cta]", { opacity: 0, y: 18 }, { opacity: 1, y: 0, duration: 0.7 }, 0.68)
        .fromTo(
          "[data-hero-video]",
          { opacity: 0, y: 40, scale: 0.96 },
          { opacity: 1, y: 0, scale: 1, duration: 1 },
          0.8,
        )
        .fromTo(
          "[data-hero-readout]",
          { opacity: 0, y: 10 },
          { opacity: 1, y: 0, duration: 0.5, stagger: 0.07 },
          1.05,
        );

      /* REC dots pulse */
      gsap.to("[data-rec-dot]", {
        opacity: 0.25,
        duration: 0.7,
        yoyo: true,
        repeat: -1,
        ease: "power1.inOut",
      });

      /* pinned horizontal scrub — desktop only; mobile keeps native overflow-x */
      if (track && !isMobile) {
        const distance = () => Math.max(track.scrollWidth - window.innerWidth, 0);
        const highlight = () => {
          const center = window.innerWidth / 2;
          cards.forEach((card) => {
            const r = card.getBoundingClientRect();
            card.classList.toggle("is-live", r.left < center && r.right > center);
          });
        };
        gsap.to(track, {
          x: () => -distance(),
          ease: "none",
          scrollTrigger: {
            trigger: "[data-scrub-section]",
            start: "top top",
            end: () => `+=${Math.max(distance(), 600)}`,
            pin: "[data-scrub-pin]",
            scrub: 0.5,
            invalidateOnRefresh: true,
            onUpdate: highlight,
          },
        });
        highlight();
      }

      /* generic reveals */
      gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
        gsap.fromTo(
          el,
          { autoAlpha: 0, y: 26 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.85,
            ease: "power3.out",
            scrollTrigger: { trigger: el, start: "top 84%" },
          },
        );
      });

      /* rack LEDs light as they enter */
      gsap.utils.toArray<HTMLElement>("[data-led]").forEach((led) => {
        gsap.to(led, {
          backgroundColor: ACCENT,
          boxShadow: `0 0 12px ${ACCENT}`,
          duration: 0.45,
          ease: "power2.out",
          scrollTrigger: { trigger: led, start: "top 82%" },
        });
      });

      /* score counter + meters */
      if (scoreEl) {
        const obj = { v: 0 };
        gsap.to(obj, {
          v: 92,
          duration: 1.8,
          ease: "power2.out",
          scrollTrigger: { trigger: "[data-score-section]", start: "top 70%" },
          onUpdate() {
            scoreEl.textContent = String(Math.round(obj.v));
          },
        });
      }
      gsap.to("[data-score-meter]", {
        scaleX: 0.92,
        duration: 1.8,
        ease: "power2.out",
        scrollTrigger: { trigger: "[data-score-section]", start: "top 70%" },
      });
      momentBars.forEach((bar) => {
        gsap.to(bar, {
          scaleX: Number(bar.dataset.score ?? 0) / 100,
          duration: 1.2,
          ease: "power2.out",
          scrollTrigger: { trigger: bar, start: "top 85%" },
        });
      });
    },
    { scope: rootRef },
  );

  return (
    <SmoothScroll>
      <Box ref={rootRef} bg="studio.canvas" color="studio.fg" minH="100vh">
        <TransportNav />
        <main>
          <Hero />
          <TimelineScrub />
          <Rack />
          <CaptionMonitor />
          <ScoreMeter />
          <ExportQueue />
          <ClosingCta />
        </main>
        <VariantDial />
      </Box>
    </SmoothScroll>
  );
}
