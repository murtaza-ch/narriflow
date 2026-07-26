"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Box, Flex, Grid, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Logo } from "@narriflow/ui/components/logo";
import { SmoothScroll } from "../../_components/smooth-scroll";
import { VariantDial } from "../../_components/variant-dial";
import { CAPTION_PRESETS, PLATFORMS, TIERS } from "../../_components/landing-data";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
}

const Video = chakra("video");

/* Volt palette — dark neo-brutalism on the Blueline blues (studio-chrome exception). */
const CANVAS = "#0B0D12";
const CARD = "#151A23";
const CARD_RAISED = "#1B2230";
const PORCELAIN = "#F2F4F8";
const MUTED = "rgba(242,244,248,0.62)";
const FAINT = "rgba(242,244,248,0.38)";
const ULTRA = "#2438E8";
const ULTRA_LIGHT = "#5B6CFF";
const INKLABEL = "#0A0D2A";
const EDGE = "rgba(91,108,255,0.32)";
const SHADOW = `0 6px 0 0 ${ULTRA}`;
const SHADOW_HOVER = `0 11px 0 0 ${ULTRA}`;

const CAPTION_WORDS = ["Stop", "editing", "shorts", "by", "hand"];

const MOMENTS = [
  { tc: "00:12:41", score: 92, note: "hook + payoff" },
  { tc: "00:31:05", score: 87, note: "hot take" },
  { tc: "00:44:56", score: 74, note: "story beat" },
];

/* ------------------------------ shared atoms ------------------------------ */

function Pill({
  children,
  tone = "ultra",
}: {
  children: React.ReactNode;
  tone?: "ultra" | "paper";
}) {
  const styles =
    tone === "ultra"
      ? { background: ULTRA_LIGHT, color: INKLABEL }
      : { background: PORCELAIN, color: INKLABEL };
  return (
    <Text
      as="span"
      display="inline-block"
      fontFamily="display"
      fontWeight="650"
      fontSize="inherit"
      lineHeight="1.25"
      px="2"
      borderRadius="8px"
      style={styles}
    >
      {children}
    </Text>
  );
}

function ArrowDot({ tone = "ultra" }: { tone?: "ultra" | "dark" }) {
  return (
    <Flex
      boxSize="40px"
      borderRadius="full"
      align="center"
      justify="center"
      flexShrink={0}
      transition="transform 220ms cubic-bezier(0.34,1.56,0.64,1)"
      _groupHover={{ transform: "rotate(45deg)" }}
      style={{ background: tone === "ultra" ? ULTRA_LIGHT : CANVAS, border: `1px solid ${tone === "ultra" ? ULTRA_LIGHT : EDGE}` }}
      aria-hidden
    >
      <Text fontSize="18px" style={{ color: tone === "ultra" ? INKLABEL : ULTRA_LIGHT }} transform="rotate(-45deg)">
        →
      </Text>
    </Flex>
  );
}

function VoltButton({
  href,
  children,
  variant = "ultra",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "ultra" | "outline" | "paper";
}) {
  const styles =
    variant === "ultra"
      ? { background: ULTRA_LIGHT, color: INKLABEL, border: `1px solid ${ULTRA_LIGHT}` }
      : variant === "paper"
        ? { background: PORCELAIN, color: INKLABEL, border: `1px solid ${PORCELAIN}` }
        : { background: "transparent", color: PORCELAIN, border: `1px solid ${EDGE}` };
  return (
    <Link href={href}>
      <Box
        as="span"
        display="inline-block"
        px="8"
        py="4"
        borderRadius="14px"
        fontFamily="display"
        fontWeight="600"
        fontSize="15px"
        cursor="pointer"
        transition="transform 200ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 200ms cubic-bezier(0.34,1.56,0.64,1)"
        _hover={{ transform: "translateY(-3px)", boxShadow: SHADOW }}
        _active={{ transform: "translateY(0)", boxShadow: `0 2px 0 0 ${ULTRA}` }}
        style={styles}
      >
        {children}
      </Box>
    </Link>
  );
}

/* ---------------------------------- nav ----------------------------------- */

function VoltNav() {
  return (
    <Flex
      as="header"
      position="fixed"
      top="0"
      insetX="0"
      zIndex="60"
      h="72px"
      px={{ base: "5", md: "12" }}
      align="center"
      justify="space-between"
      style={{ background: "rgba(11,13,18,0.86)", borderBottom: `1px solid ${EDGE}` }}
      backdropFilter="blur(14px)"
    >
      <Box css={{ "--chakra-colors-fg": PORCELAIN, "--chakra-colors-accent-solid": ULTRA_LIGHT }}>
        <Link href="/" aria-label="Narriflow home">
          <Logo size="md" />
        </Link>
      </Box>
      <HStack gap="9" display={{ base: "none", lg: "flex" }}>
        {[
          ["Features", "#features"],
          ["Score", "#score"],
          ["How it works", "#process"],
          ["Pricing", "#pricing"],
        ].map(([label, href]) => (
          <Link key={label} href={href ?? "#"}>
            <Text
              fontSize="15px"
              fontWeight="500"
              style={{ color: MUTED }}
              position="relative"
              _hover={{ color: PORCELAIN, _after: { transform: "scaleX(1)" } }}
              transition="color 160ms ease"
              _after={{
                content: '""',
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "-4px",
                height: "3px",
                background: ULTRA_LIGHT,
                transform: "scaleX(0)",
                transformOrigin: "left",
                transition: "transform 240ms cubic-bezier(0.22,1,0.36,1)",
              }}
            >
              {label}
            </Text>
          </Link>
        ))}
      </HStack>
      <VoltButton href="/sign-up" variant="outline">
        Start free
      </VoltButton>
    </Flex>
  );
}

/* ---------------------------------- hero ---------------------------------- */

function Hero() {
  const [word, setWord] = useState(0);
  useEffect(() => {
    const id = window.setInterval(() => setWord((w) => (w + 1) % CAPTION_WORDS.length), 420);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Box maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "120px", md: "160px" }} position="relative">
      <Grid templateColumns={{ base: "1fr", lg: "1.05fr 1fr" }} gap={{ base: "14", lg: "10" }} alignItems="center">
        {/* copy */}
        <Stack gap="8" data-pop style={{ opacity: 0 }}>
          <HStack gap="3">
            <Box boxSize="9px" borderRadius="full" style={{ background: ULTRA_LIGHT }} data-pulse />
            <Text fontFamily="mono" fontSize="12px" letterSpacing="0.24em" style={{ color: ULTRA_LIGHT }}>
              PIPELINE ONLINE
            </Text>
          </HStack>
          <Text
            as="h1"
            fontFamily="display"
            fontWeight="650"
            letterSpacing="-0.02em"
            lineHeight="1.08"
            fontSize={{ base: "40px", md: "58px" }}
            style={{ color: PORCELAIN }}
          >
            One upload.
            <br />A <Pill>week of posts</Pill>
          </Text>
          <Text fontSize={{ base: "16px", md: "18px" }} lineHeight="1.7" style={{ color: MUTED }} maxW="46ch">
            Narriflow finds your best moments, scores every one for virality, burns
            in word-synced captions and publishes everywhere — before your coffee
            cools.
          </Text>
          <HStack gap="4" flexWrap="wrap">
            <VoltButton href="/sign-up" variant="ultra">
              Start for free
            </VoltButton>
            <VoltButton href="#score" variant="outline">
              See the scores ↓
            </VoltButton>
          </HStack>
        </Stack>

        {/* collage */}
        <Box position="relative" minH={{ base: "360px", md: "500px" }} data-pop style={{ opacity: 0 }} aria-hidden>
          {/* glow blob */}
          <Box
            position="absolute"
            top="0%"
            right="0%"
            boxSize={{ base: "220px", md: "320px" }}
            borderRadius="full"
            style={{ background: `radial-gradient(circle, ${ULTRA}66, transparent 65%)`, filter: "blur(8px)" }}
            data-float="0"
          />
          {/* speech bubble: live caption card */}
          <Box
            data-float="2"
            position="absolute"
            top={{ base: "6%", md: "8%" }}
            right={{ base: "2%", md: "1%" }}
            w={{ base: "236px", md: "310px" }}
            p={{ base: "5", md: "7" }}
            borderRadius="18px"
            style={{ background: CARD_RAISED, border: `1px solid ${EDGE}`, boxShadow: SHADOW }}
            _after={{
              content: '""',
              position: "absolute",
              left: "36px",
              bottom: "-25px",
              width: "0",
              height: "0",
              borderRight: "34px solid transparent",
              borderTop: `26px solid ${CARD_RAISED}`,
            }}
          >
            <Text fontFamily="mono" fontSize="11px" letterSpacing="0.2em" style={{ color: ULTRA_LIGHT }} mb="3">
              KARAOKE · 9:16 · LIVE
            </Text>
            <Flex gap="1.5" flexWrap="wrap">
              {CAPTION_WORDS.map((w, i) => (
                <Text
                  key={i}
                  fontFamily="display"
                  fontWeight="800"
                  textTransform="uppercase"
                  fontSize={{ base: "17px", md: "22px" }}
                  transition="color 120ms ease"
                  style={{ color: i === word ? ULTRA_LIGHT : i < word ? PORCELAIN : FAINT }}
                >
                  {w}
                </Text>
              ))}
            </Flex>
          </Box>
          {/* score ring sticker */}
          <Box data-float="3" position="absolute" top={{ base: "46%", md: "46%" }} left={{ base: "0%", md: "4%" }}>
            <Box position="relative" boxSize={{ base: "104px", md: "136px" }} borderRadius="full" style={{ background: CARD, border: `1px solid ${EDGE}`, boxShadow: SHADOW }}>
              <chakra.svg position="absolute" inset="6px" viewBox="0 0 100 100" aria-hidden>
                <circle cx="50" cy="50" r="44" stroke="rgba(242,244,248,0.12)" strokeWidth="6" fill="none" />
                <circle
                  cx="50"
                  cy="50"
                  r="44"
                  stroke={ULTRA_LIGHT}
                  strokeWidth="6"
                  fill="none"
                  strokeLinecap="round"
                  strokeDasharray={2 * Math.PI * 44}
                  strokeDashoffset={2 * Math.PI * 44 * (1 - 0.92)}
                  transform="rotate(-90 50 50)"
                />
              </chakra.svg>
              <Flex position="absolute" inset="0" align="center" justify="center" direction="column">
                <Text fontFamily="mono" fontWeight="600" fontSize={{ base: "30px", md: "38px" }} lineHeight="1" style={{ color: PORCELAIN }} data-hero-score>
                  92
                </Text>
                <Text fontFamily="mono" fontSize="9px" letterSpacing="0.22em" style={{ color: FAINT }}>
                  SCORE
                </Text>
              </Flex>
            </Box>
          </Box>
          {/* bolt sticker */}
          <Flex
            data-float="4"
            position="absolute"
            top={{ base: "34%", md: "32%" }}
            left={{ base: "36%", md: "40%" }}
            boxSize="64px"
            borderRadius="full"
            align="center"
            justify="center"
            style={{ background: ULTRA_LIGHT }}
          >
            <Text fontSize="28px" fontWeight="700" style={{ color: INKLABEL }}>
              +
            </Text>
          </Flex>
          {/* glowing dot grid */}
          <Box
            data-float="5"
            position="absolute"
            bottom="4%"
            left={{ base: "16%", md: "24%" }}
            w={{ base: "180px", md: "240px" }}
            h={{ base: "120px", md: "170px" }}
            style={{
              backgroundImage: `radial-gradient(${ULTRA_LIGHT} 2px, transparent 2px)`,
              backgroundSize: "22px 22px",
              opacity: 0.55,
              maskImage: "linear-gradient(160deg, black 55%, transparent)",
            }}
          />
          {/* ratio frames chip */}
          <Flex
            data-float="6"
            position="absolute"
            bottom={{ base: "16%", md: "14%" }}
            right={{ base: "4%", md: "10%" }}
            px="5"
            py="3.5"
            gap="3"
            align="flex-end"
            borderRadius="14px"
            style={{ background: CARD, border: `1px solid ${EDGE}`, boxShadow: SHADOW }}
          >
            {[
              { w: 16, h: 30 },
              { w: 24, h: 24 },
              { w: 38, h: 22 },
              { w: 20, h: 26 },
            ].map((f, i) => (
              <Box key={i} borderRadius="4px" data-ratio-frame style={{ width: `${f.w}px`, height: `${f.h}px`, border: `2px solid ${i === 0 ? ULTRA_LIGHT : "rgba(242,244,248,0.5)"}`, background: i === 0 ? `${ULTRA_LIGHT}22` : "transparent" }} />
            ))}
          </Flex>
        </Box>
      </Grid>

      {/* ticker: filled / outlined alternating */}
      <Box mt={{ base: "16", md: "24" }} overflow="hidden" py="2" aria-hidden>
        <Box display="inline-flex" whiteSpace="nowrap" data-ticker>
          {[0, 1].map((dup) => (
            <HStack key={dup} gap={{ base: "12", md: "20" }} pr={{ base: "12", md: "20" }} flexShrink={0}>
              {[...PLATFORMS, "Podcasts", "Webinars"].map((p, i) => (
                <Text
                  key={`${dup}-${p}`}
                  fontFamily="display"
                  fontWeight="800"
                  fontSize={{ base: "22px", md: "30px" }}
                  letterSpacing="-0.01em"
                  textTransform="uppercase"
                  style={
                    i % 2
                      ? { color: "transparent", WebkitTextStroke: `1.5px ${ULTRA_LIGHT}` }
                      : { color: PORCELAIN }
                  }
                >
                  {p}
                </Text>
              ))}
            </HStack>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/* ------------------------------ section header ----------------------------- */

function VoltHeading({ id, pill, blurb, tone = "ultra" }: { id?: string; pill: string; blurb: string; tone?: "ultra" | "paper" }) {
  return (
    <Flex
      id={id}
      data-pop
      style={{ opacity: 0 }}
      align={{ base: "flex-start", md: "center" }}
      direction={{ base: "column", md: "row" }}
      gap={{ base: "4", md: "10" }}
      css={id ? { scrollMarginTop: "84px" } : undefined}
    >
      <Text fontFamily="display" fontWeight="650" fontSize={{ base: "30px", md: "40px" }} letterSpacing="-0.01em" flexShrink={0}>
        <Pill tone={tone}>{pill}</Pill>
      </Text>
      <Text fontSize="15px" lineHeight="1.65" maxW="46ch" style={{ color: MUTED }}>
        {blurb}
      </Text>
    </Flex>
  );
}

/* --------------------------------- services -------------------------------- */

type Service = {
  a: string;
  b: string;
  scheme: "card" | "ultra" | "cyanline";
  vignette: "waveform" | "captions" | "ratios" | "reframe" | "suite" | "publish";
};

const SERVICES: Service[] = [
  { a: "Moment", b: "detection", scheme: "card", vignette: "waveform" },
  { a: "Word-synced", b: "captions", scheme: "ultra", vignette: "captions" },
  { a: "Every aspect", b: "ratio", scheme: "cyanline", vignette: "ratios" },
  { a: "Auto-reframe", b: "+ B-roll", scheme: "card", vignette: "reframe" },
  { a: "Content", b: "repurposing", scheme: "ultra", vignette: "suite" },
  { a: "Direct", b: "publishing", scheme: "cyanline", vignette: "publish" },
];

function ServiceVignette({ kind, scheme }: { kind: Service["vignette"]; scheme: Service["scheme"] }) {
  const main = scheme === "ultra" ? INKLABEL : PORCELAIN;
  const accent = scheme === "ultra" ? PORCELAIN : ULTRA_LIGHT;
  if (kind === "waveform") {
    return (
      <Flex gap="1.5" align="flex-end" h="64px" aria-hidden>
        {[18, 34, 24, 48, 30, 56, 40, 22, 44, 28, 14, 36].map((h, i) => (
          <Box key={i} w="7px" borderRadius="4px" data-service-bar style={{ height: `${h}px`, background: i === 5 ? accent : main, opacity: i === 5 ? 1 : 0.6, boxShadow: "none" }} />
        ))}
      </Flex>
    );
  }
  if (kind === "captions") {
    return (
      <Stack gap="2" aria-hidden>
        <Box h="12px" w="120px" borderRadius="6px" style={{ background: main, opacity: 0.8 }} />
        <HStack gap="2">
          <Box h="12px" w="52px" borderRadius="6px" style={{ background: accent }} />
          <Box h="12px" w="76px" borderRadius="6px" style={{ background: main, opacity: 0.35 }} />
        </HStack>
      </Stack>
    );
  }
  if (kind === "ratios") {
    return (
      <HStack gap="3" align="flex-end" aria-hidden>
        {[
          { w: 22, h: 40 },
          { w: 34, h: 34 },
          { w: 52, h: 30 },
          { w: 28, h: 36 },
        ].map((f, i) => (
          <Box key={i} borderRadius="6px" style={{ width: `${f.w}px`, height: `${f.h}px`, border: `2px solid ${i === 0 ? accent : main}`, opacity: i === 0 ? 1 : 0.6, background: i === 0 ? `${accent}1E` : "transparent" }} />
        ))}
      </HStack>
    );
  }
  if (kind === "reframe") {
    return (
      <Box position="relative" w="110px" h="64px" borderRadius="8px" aria-hidden style={{ border: `2px solid ${main}`, opacity: 0.85 }}>
        <Box position="absolute" top="8px" bottom="8px" left="30px" w="34px" borderRadius="6px" style={{ border: `2px dashed ${accent}` }} />
        <Box position="absolute" top="20px" left="40px" boxSize="14px" borderRadius="full" style={{ background: main }} />
      </Box>
    );
  }
  if (kind === "suite") {
    return (
      <Stack gap="2" aria-hidden>
        {["Blog", "Thread", "Notes"].map((t) => (
          <HStack key={t} gap="2">
            <Box boxSize="7px" borderRadius="full" style={{ background: accent }} />
            <Text fontFamily="mono" fontSize="11px" letterSpacing="0.14em" style={{ color: main }}>
              {t.toUpperCase()}
            </Text>
          </HStack>
        ))}
      </Stack>
    );
  }
  return (
    <HStack gap="2" flexWrap="wrap" maxW="180px" aria-hidden>
      {["TikTok", "Shorts", "Reels", "X"].map((p) => (
        <Text key={p} fontFamily="mono" fontSize="10.5px" px="2.5" py="1" borderRadius="full" style={{ border: `1.5px solid ${main}`, color: main, opacity: 0.85 }}>
          {p}
        </Text>
      ))}
    </HStack>
  );
}

function Services() {
  return (
    <Box id="features" maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <VoltHeading
        pill="What it does"
        blurb="One upload runs the whole pipeline. Every card below is a real stage of the machine — no add-ons, no credit math."
      />
      <Grid mt={{ base: "8", md: "12" }} templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap={{ base: "6", md: "8" }}>
        {SERVICES.map((s) => {
          const styles =
            s.scheme === "ultra"
              ? { background: ULTRA_LIGHT, border: `1px solid ${ULTRA_LIGHT}`, boxShadow: SHADOW }
              : s.scheme === "cyanline"
                ? { background: CARD_RAISED, border: `1px solid ${EDGE}`, boxShadow: SHADOW }
                : { background: CARD, border: `1px solid ${EDGE}`, boxShadow: SHADOW };
          const pillTone = s.scheme === "ultra" ? "paper" : "ultra";
          return (
            <Box
              key={s.a}
              data-pop
              style={{ opacity: 0 }}
              role="group"
              p={{ base: "8", md: "10" }}
              borderRadius="34px"
              transition="transform 240ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 240ms cubic-bezier(0.34,1.56,0.64,1)"
              _hover={{ transform: "translateY(-5px)", boxShadow: SHADOW_HOVER }}
              css={styles}
            >
              <Flex justify="space-between" gap="8" align="flex-start">
                <Stack gap="1" fontSize={{ base: "22px", md: "26px" }}>
                  <Box>
                    <Pill tone={pillTone as "ultra" | "paper"}>{s.a}</Pill>
                  </Box>
                  <Box>
                    <Pill tone={pillTone as "ultra" | "paper"}>{s.b}</Pill>
                  </Box>
                </Stack>
                <ServiceVignette kind={s.vignette} scheme={s.scheme} />
              </Flex>
              <Flex mt={{ base: "10", md: "14" }} align="center" gap="4">
                <ArrowDot tone={s.scheme === "ultra" ? "dark" : "ultra"} />
                <Text fontSize="15px" fontWeight="500" style={{ color: s.scheme === "ultra" ? INKLABEL : PORCELAIN }}>
                  Learn more
                </Text>
              </Flex>
            </Box>
          );
        })}
      </Grid>
    </Box>
  );
}

/* ------------------------------- score gauge ------------------------------- */

const METER_CELLS = 20;

function ScoreGauge() {
  const [selected, setSelected] = useState(0);
  const score = MOMENTS[selected]?.score ?? 92;
  const filled = Math.round((score / 100) * METER_CELLS);

  return (
    <Box id="score" maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <VoltHeading
        pill="The score"
        blurb="Every moment is graded 0–100 before you render a single frame. Click a moment — the meter follows."
      />
      <Grid
        mt={{ base: "8", md: "12" }}
        data-pop
        style={{ opacity: 0 }}
        templateColumns={{ base: "1fr", lg: "1fr 1fr" }}
        gap={{ base: "10", lg: "16" }}
        alignItems="center"
        p={{ base: "8", md: "14" }}
        borderRadius="40px"
        css={{ background: CARD, border: `1px solid ${EDGE}`, boxShadow: SHADOW }}
      >
        {/* score meter */}
        <Stack gap="7" justify="center">
          <HStack align="baseline" gap="2">
            <Text
              fontFamily="mono"
              fontWeight="600"
              fontSize={{ base: "72px", md: "96px" }}
              lineHeight="1"
              letterSpacing="-0.04em"
              style={{ color: PORCELAIN, fontVariantNumeric: "tabular-nums" }}
            >
              {score}
            </Text>
            <Text fontFamily="mono" fontSize="18px" style={{ color: FAINT }}>
              /100
            </Text>
          </HStack>
          {/* segmented block meter */}
          <Flex gap={{ base: "1", md: "1.5" }} aria-hidden>
            {Array.from({ length: METER_CELLS }).map((_, i) => {
              const on = i < filled;
              return (
                <Box
                  key={i}
                  flex="1"
                  h={{ base: "34px", md: "44px" }}
                  borderRadius="6px"
                  transition="background 420ms cubic-bezier(0.22,1,0.36,1), border-color 420ms ease"
                  style={{
                    transitionDelay: `${i * 22}ms`,
                    background: on ? ULTRA_LIGHT : "transparent",
                    border: `1px solid ${on ? ULTRA_LIGHT : EDGE}`,
                  }}
                />
              );
            })}
          </Flex>
          <Flex justify="space-between" align="baseline">
            <Text fontFamily="mono" fontSize="11px" letterSpacing="0.22em" style={{ color: ULTRA_LIGHT }}>
              VIRALITY ENGINE
            </Text>
            <Text fontFamily="mono" fontSize="11px" letterSpacing="0.14em" style={{ color: FAINT }}>
              {MOMENTS[selected]?.tc ?? "00:12:41"}
            </Text>
          </Flex>
        </Stack>

        {/* moment rows */}
        <Stack gap="4">
          {MOMENTS.map((m, i) => {
            const active = i === selected;
            return (
              <Flex
                key={m.tc}
                as="button"
                onClick={() => setSelected(i)}
                align="center"
                justify="space-between"
                gap="5"
                px={{ base: "5", md: "7" }}
                py={{ base: "4", md: "5" }}
                borderRadius="18px"
                cursor="pointer"
                textAlign="left"
                transition="transform 200ms cubic-bezier(0.34,1.56,0.64,1), background 200ms ease, border-color 200ms ease, box-shadow 200ms ease"
                _hover={{ transform: "translateY(-2px)" }}
                css={{
                  background: active ? CARD_RAISED : "transparent",
                  border: `1px solid ${active ? ULTRA_LIGHT : EDGE}`,
                  boxShadow: active ? `0 5px 0 0 ${ULTRA}` : "none",
                }}
                aria-pressed={active}
              >
                <HStack gap="4">
                  <Text fontFamily="mono" fontSize="14px" style={{ color: active ? ULTRA_LIGHT : FAINT }}>
                    {m.tc}
                  </Text>
                  <Text fontSize="14px" fontWeight="500" style={{ color: active ? PORCELAIN : MUTED }}>
                    {m.note}
                  </Text>
                </HStack>
                <HStack gap="3">
                  {i === 0 && (
                    <Text fontFamily="mono" fontSize="10px" letterSpacing="0.14em" px="2.5" py="1" borderRadius="full" style={{ background: ULTRA_LIGHT, color: INKLABEL }}>
                      RENDER
                    </Text>
                  )}
                  <Text fontFamily="mono" fontWeight="600" fontSize="20px" style={{ color: active ? PORCELAIN : MUTED }}>
                    {m.score}
                  </Text>
                </HStack>
              </Flex>
            );
          })}
          <Text fontFamily="mono" fontSize="11.5px" letterSpacing="0.1em" style={{ color: FAINT }} pl="2">
            RENDER THE WINNERS · ARCHIVE THE REST
          </Text>
        </Stack>
      </Grid>
    </Box>
  );
}

/* --------------------------------- banner ---------------------------------- */

function Banner() {
  return (
    <Box maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <Grid
        data-pop
        style={{ opacity: 0 }}
        templateColumns={{ base: "1fr", lg: "1fr 480px" }}
        gap={{ base: "10", lg: "16" }}
        alignItems="center"
        p={{ base: "8", md: "14" }}
        borderRadius="40px"
        css={{ background: `linear-gradient(135deg, ${ULTRA} 0%, #1A2AB8 100%)`, border: `1px solid ${ULTRA_LIGHT}`, boxShadow: "0 6px 0 0 #0A0D2A" }}
      >
        <Stack gap="6">
          <Text fontFamily="display" fontWeight="650" fontSize={{ base: "26px", md: "34px" }} letterSpacing="-0.01em" style={{ color: PORCELAIN }}>
            Watch the machine work
          </Text>
          <Text fontSize="15.5px" lineHeight="1.7" style={{ color: "rgba(242,244,248,0.8)" }} maxW="44ch">
            A 47-minute podcast goes in. Six scored clips, word-synced captions in
            every ratio, a blog post and an X thread come out — nine minutes of
            compute, five of your time.
          </Text>
          <Box>
            <VoltButton href="/sign-up" variant="paper">
              Run your first upload free
            </VoltButton>
          </Box>
        </Stack>
        <Box borderRadius="24px" overflow="hidden" css={{ border: `1px solid rgba(242,244,248,0.35)`, boxShadow: "0 6px 0 0 #0A0D2A" }}>
          <Video src="/videos/moment-detect.mp4" autoPlay muted loop playsInline preload="metadata" w="full" display="block" />
        </Box>
      </Grid>
    </Box>
  );
}

/* -------------------------------- process ---------------------------------- */

const PROCESS = [
  { n: "01", title: "Upload anything", body: "Drop a file, paste a YouTube link, or point the RSS autopilot at your feed — new episodes queue themselves." },
  { n: "02", title: "Transcription", body: "Word-level speech-to-text builds the timing backbone every caption, cut and score relies on." },
  { n: "03", title: "Moment detection", body: "AI reads the whole transcript and scores every clip-worthy moment 0–100, so you only render the winners." },
  { n: "04", title: "Rendering", body: "Captions burn in exactly as previewed — 12 presets, 9 animation styles, every aspect ratio, auto-reframed around the speaker." },
  { n: "05", title: "Repurposing", body: "The same transcript drafts a blog post, an X thread, a LinkedIn post, show notes and quote cards." },
  { n: "06", title: "Publishing", body: "Schedule straight to TikTok, Shorts, Reels, LinkedIn and X — then watch views, likes and shares roll back in." },
];

function Process() {
  const [open, setOpen] = useState(0);
  return (
    <Box id="process" maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <VoltHeading pill="How it works" blurb="Three minutes of clicking for you. Six stages of work for the machine." />
      <Stack mt={{ base: "8", md: "12" }} gap={{ base: "5", md: "7" }}>
        {PROCESS.map((step, i) => {
          const isOpen = open === i;
          return (
            <Box
              key={step.n}
              data-pop
              style={{ opacity: 0 }}
              borderRadius={{ base: "24px", md: "40px" }}
              px={{ base: "6", md: "14" }}
              py={{ base: "6", md: "9" }}
              cursor="pointer"
              onClick={() => setOpen(isOpen ? -1 : i)}
              transition="background 260ms ease, transform 240ms cubic-bezier(0.34,1.56,0.64,1), border-color 260ms ease"
              _hover={{ transform: isOpen ? "none" : "translateY(-3px)" }}
              css={{
                background: isOpen ? ULTRA_LIGHT : CARD,
                border: `1px solid ${isOpen ? ULTRA_LIGHT : EDGE}`,
                boxShadow: SHADOW,
              }}
              aria-expanded={isOpen}
            >
              <Flex align="center" justify="space-between" gap="6">
                <HStack gap={{ base: "4", md: "7" }} align="baseline">
                  <Text fontFamily="display" fontWeight="650" fontSize={{ base: "34px", md: "56px" }} letterSpacing="-0.03em" style={{ color: isOpen ? INKLABEL : PORCELAIN }}>
                    {step.n}
                  </Text>
                  <Text fontFamily="display" fontWeight="650" fontSize={{ base: "18px", md: "28px" }} letterSpacing="-0.01em" style={{ color: isOpen ? INKLABEL : PORCELAIN }}>
                    {step.title}
                  </Text>
                </HStack>
                <Flex
                  boxSize={{ base: "38px", md: "52px" }}
                  borderRadius="full"
                  align="center"
                  justify="center"
                  flexShrink={0}
                  transition="transform 300ms cubic-bezier(0.34,1.56,0.64,1)"
                  transform={isOpen ? "rotate(45deg)" : "none"}
                  css={{ background: isOpen ? INKLABEL : CANVAS, border: `1px solid ${isOpen ? INKLABEL : EDGE}` }}
                  aria-hidden
                >
                  <Text fontSize={{ base: "20px", md: "26px" }} fontWeight="600" style={{ color: ULTRA_LIGHT }}>
                    +
                  </Text>
                </Flex>
              </Flex>
              <Box display="grid" gridTemplateRows={isOpen ? "1fr" : "0fr"} transition="grid-template-rows 380ms cubic-bezier(0.22,1,0.36,1)">
                <Box overflow="hidden">
                  <Box mt={{ base: "4", md: "6" }} pt={{ base: "4", md: "6" }} style={{ borderTop: `1px solid ${isOpen ? "rgba(10,13,42,0.35)" : EDGE}` }}>
                    <Text fontSize={{ base: "14.5px", md: "16px" }} lineHeight="1.7" style={{ color: isOpen ? INKLABEL : MUTED }} maxW="70ch">
                      {step.body}
                    </Text>
                  </Box>
                </Box>
              </Box>
            </Box>
          );
        })}
      </Stack>
    </Box>
  );
}

/* ---------------------------- caption playground ---------------------------- */

function CaptionLab() {
  const [preset, setPreset] = useState(0);
  const [word, setWord] = useState(0);
  const featured = CAPTION_PRESETS.slice(0, 8);
  const active = featured[preset] ?? { name: "Karaoke", accent: "#00FF88" };

  useEffect(() => {
    const id = window.setInterval(() => setWord((w) => (w + 1) % (CAPTION_WORDS.length + 1)), 400);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Box maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <VoltHeading pill="Caption lab" blurb="Twelve presets, nine animation styles, word-synced to the waveform. Pick one — the preview is the export." />
      <Grid
        mt={{ base: "8", md: "12" }}
        templateColumns={{ base: "1fr", lg: "1fr 360px" }}
        gap={{ base: "8", lg: "12" }}
        alignItems="stretch"
      >
        {/* interactive stage */}
        <Stack
          data-pop
          style={{ opacity: 0 }}
          p={{ base: "8", md: "12" }}
          gap={{ base: "8", md: "10" }}
          borderRadius="40px"
          justify="center"
          css={{ background: CARD, border: `1px solid ${EDGE}`, boxShadow: SHADOW }}
        >
          <Flex minH={{ base: "120px", md: "160px" }} align="center" justify="center" gap="0.4em" flexWrap="wrap">
            {CAPTION_WORDS.map((w, i) => {
              const on = i === word;
              const seen = i <= word;
              return (
                <Text
                  key={i}
                  fontFamily="display"
                  fontWeight="800"
                  textTransform="uppercase"
                  fontSize={{ base: "28px", md: "46px" }}
                  letterSpacing="-0.01em"
                  transition="color 160ms ease, transform 160ms ease"
                  style={{
                    color: on ? active.accent : seen ? PORCELAIN : FAINT,
                    transform: on ? "scale(1.06)" : "scale(1)",
                  }}
                >
                  {w}
                </Text>
              );
            })}
          </Flex>
          <Flex gap="2.5" flexWrap="wrap" justify="center">
            {featured.map((p, i) => (
              <Box
                key={p.name}
                as="button"
                onClick={() => setPreset(i)}
                px="4"
                py="2"
                borderRadius="full"
                cursor="pointer"
                transition="transform 200ms cubic-bezier(0.34,1.56,0.64,1), background 200ms ease, border-color 200ms ease"
                _hover={{ transform: "translateY(-2px)" }}
                css={{
                  background: i === preset ? `${p.accent}1F` : "transparent",
                  border: `1.5px solid ${i === preset ? p.accent : EDGE}`,
                }}
                aria-pressed={i === preset}
              >
                <HStack gap="2">
                  <Box boxSize="8px" borderRadius="full" style={{ background: p.accent }} />
                  <Text fontSize="12.5px" fontWeight="600" style={{ color: i === preset ? PORCELAIN : MUTED }}>
                    {p.name}
                  </Text>
                </HStack>
              </Box>
            ))}
          </Flex>
        </Stack>

        {/* phone video */}
        <Box data-pop style={{ opacity: 0 }} justifySelf={{ base: "center", lg: "stretch" }} w={{ base: "250px", lg: "auto" }}>
          <Box borderRadius="30px" overflow="hidden" css={{ border: `1px solid ${EDGE}`, boxShadow: SHADOW }}>
            <Video src="/videos/caption-loop.mp4" autoPlay muted loop playsInline preload="metadata" w="full" display="block" />
          </Box>
        </Box>
      </Grid>
    </Box>
  );
}

/* --------------------------------- pricing --------------------------------- */

function Pricing() {
  return (
    <Box id="pricing" maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <VoltHeading pill="Pricing" blurb="A minute of source media is one processing minute. That's the whole pricing model." />
      <Grid mt={{ base: "8", md: "12" }} templateColumns={{ base: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" }} gap={{ base: "6", md: "7" }}>
        {TIERS.map((t) => {
          const featured = t.featured;
          return (
            <Stack
              key={t.name}
              data-pop
              style={{ opacity: 0 }}
              p={{ base: "7", md: "8" }}
              gap="5"
              borderRadius="28px"
              transition="transform 240ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 240ms cubic-bezier(0.34,1.56,0.64,1)"
              _hover={{ transform: "translateY(-5px)", boxShadow: SHADOW_HOVER }}
              css={{
                background: featured ? ULTRA_LIGHT : CARD,
                border: `1px solid ${featured ? ULTRA_LIGHT : EDGE}`,
                boxShadow: SHADOW,
              }}
            >
              <Flex justify="space-between" align="center">
                <Text fontFamily="display" fontWeight="650" fontSize="20px" style={{ color: featured ? INKLABEL : PORCELAIN }}>
                  {t.name}
                </Text>
                {featured && (
                  <Text fontFamily="mono" fontSize="10px" letterSpacing="0.14em" px="2.5" py="1" borderRadius="full" style={{ background: INKLABEL, color: ULTRA_LIGHT }}>
                    POPULAR
                  </Text>
                )}
              </Flex>
              <HStack align="baseline" gap="1">
                <Text fontFamily="display" fontWeight="650" fontSize="44px" letterSpacing="-0.03em" style={{ color: featured ? INKLABEL : PORCELAIN }}>
                  ${t.price}
                </Text>
                <Text fontSize="14px" style={{ color: featured ? "rgba(10,13,42,0.6)" : FAINT }}>
                  /mo
                </Text>
              </HStack>
              <Stack gap="2.5" flex="1">
                {t.points.map((p) => (
                  <HStack key={p} gap="2.5" align="flex-start">
                    <Text fontSize="13px" fontWeight="700" style={{ color: featured ? INKLABEL : ULTRA_LIGHT }} aria-hidden>
                      ✓
                    </Text>
                    <Text fontSize="13.5px" lineHeight="1.55" style={{ color: featured ? "rgba(10,13,42,0.85)" : MUTED }}>
                      {p}
                    </Text>
                  </HStack>
                ))}
              </Stack>
              <VoltButton href="/sign-up" variant={featured ? "paper" : "outline"}>
                {t.price === 0 ? "Start free" : `Choose ${t.name}`}
              </VoltButton>
            </Stack>
          );
        })}
      </Grid>
    </Box>
  );
}

/* --------------------------------- footer ---------------------------------- */

function VoltFooter() {
  return (
    <Box maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }} pb={{ base: "8", md: "12" }}>
      <Box
        data-pop
        style={{ opacity: 0 }}
        borderRadius="40px 40px 0 0"
        px={{ base: "8", md: "14" }}
        py={{ base: "10", md: "14" }}
        position="relative"
        overflow="hidden"
        css={{ background: `linear-gradient(135deg, ${ULTRA} 0%, #16249C 100%)`, border: `1px solid ${ULTRA_LIGHT}`, borderBottom: "none" }}
      >
        {/* glow dots */}
        <Box
          position="absolute"
          inset="0"
          style={{ backgroundImage: `radial-gradient(rgba(242,244,248,0.22) 1.5px, transparent 1.5px)`, backgroundSize: "26px 26px", maskImage: "linear-gradient(120deg, transparent 40%, black)" }}
          aria-hidden
        />
        <Flex position="relative" direction={{ base: "column", md: "row" }} justify="space-between" align={{ base: "flex-start", md: "center" }} gap="8">
          <Stack gap="4">
            <Text fontFamily="display" fontWeight="650" fontSize={{ base: "26px", md: "34px" }} letterSpacing="-0.01em" style={{ color: PORCELAIN }}>
              Press record on your next <Pill tone="paper">hundred posts</Pill>
            </Text>
            <Text fontSize="14.5px" style={{ color: "rgba(242,244,248,0.7)" }}>
              Free plan · 60 processing minutes a month · no card required
            </Text>
          </Stack>
          <VoltButton href="/sign-up" variant="paper">
            Start for free
          </VoltButton>
        </Flex>
        <Flex position="relative" mt={{ base: "10", md: "14" }} pt="6" justify="space-between" flexWrap="wrap" gap="4" style={{ borderTop: "1px solid rgba(242,244,248,0.25)" }}>
          <Text fontFamily="mono" fontSize="11px" letterSpacing="0.14em" style={{ color: "rgba(242,244,248,0.6)" }}>
            © {new Date().getFullYear()} NARRIFLOW
          </Text>
          <HStack gap="6">
            <Link href="/privacy">
              <Text fontSize="12.5px" style={{ color: "rgba(242,244,248,0.7)" }} _hover={{ color: PORCELAIN }} transition="color 140ms ease">
                Privacy
              </Text>
            </Link>
            <Link href="/terms">
              <Text fontSize="12.5px" style={{ color: "rgba(242,244,248,0.7)" }} _hover={{ color: PORCELAIN }} transition="color 140ms ease">
                Terms
              </Text>
            </Link>
          </HStack>
        </Flex>
      </Box>
    </Box>
  );
}

/* ----------------------------------- page ---------------------------------- */

export function VoltClient() {
  const rootRef = useRef<HTMLDivElement>(null);
  const spotRef = useRef<HTMLDivElement>(null);

  /* cursor spotlight — desktop, fine pointers only */
  useEffect(() => {
    const spot = spotRef.current;
    if (!spot) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const move = (e: MouseEvent) => {
      spot.style.background = `radial-gradient(560px circle at ${e.clientX}px ${e.clientY}px, rgba(91,108,255,0.06), transparent 70%)`;
    };
    window.addEventListener("mousemove", move, { passive: true });
    return () => window.removeEventListener("mousemove", move);
  }, []);

  useGSAP(
    () => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        gsap.set("[data-pop]", { opacity: 1 });
        return;
      }

      gsap.utils.toArray<HTMLElement>("[data-pop]").forEach((el) => {
        gsap.fromTo(
          el,
          { opacity: 0, y: 34, rotate: -1.2, scale: 0.985 },
          {
            opacity: 1,
            y: 0,
            rotate: 0,
            scale: 1,
            duration: 0.85,
            ease: "back.out(1.3)",
            scrollTrigger: { trigger: el, start: "top 87%" },
          },
        );
      });

      gsap.utils.toArray<HTMLElement>("[data-float]").forEach((el, i) => {
        gsap.to(el, {
          y: i % 2 ? 12 : -12,
          duration: 2.4 + i * 0.35,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
        });
      });

      gsap.to("[data-ticker]", { xPercent: -50, duration: 26, ease: "none", repeat: -1 });

      gsap.utils.toArray<HTMLElement>("[data-service-bar]").forEach((bar, i) => {
        gsap.to(bar, {
          scaleY: 0.55 + ((i * 29) % 8) / 10,
          transformOrigin: "bottom",
          duration: 0.6 + ((i * 17) % 6) / 10,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
        });
      });

      // pulse dot
      gsap.to("[data-pulse]", { opacity: 0.35, duration: 0.9, ease: "sine.inOut", yoyo: true, repeat: -1 });

      // hero score ring ticks between values
      const scoreEl = document.querySelector("[data-hero-score]");
      if (scoreEl) {
        const values = [92, 87, 74];
        let idx = 0;
        gsap.timeline({ repeat: -1, repeatDelay: 1.8 }).call(() => {
          idx = (idx + 1) % values.length;
          scoreEl.textContent = String(values[idx]);
        });
      }

      // ratio frames breathe
      gsap.utils.toArray<HTMLElement>("[data-ratio-frame]").forEach((el, i) => {
        gsap.to(el, { scale: 1.12, duration: 1 + i * 0.2, ease: "sine.inOut", yoyo: true, repeat: -1, delay: i * 0.3 });
      });
    },
    { scope: rootRef },
  );

  return (
    <SmoothScroll>
      {/* Volt is mode-invariant dark chrome — literal graphite/blue palette */}
      <Box ref={rootRef} minH="100vh" overflowX="clip" position="relative" style={{ background: CANVAS, color: PORCELAIN }}>
        {/* ambient blueprint grid */}
        <Box
          position="fixed"
          inset="0"
          zIndex="0"
          pointerEvents="none"
          style={{
            backgroundImage: `linear-gradient(rgba(91,108,255,0.055) 1px, transparent 1px), linear-gradient(90deg, rgba(91,108,255,0.055) 1px, transparent 1px)`,
            backgroundSize: "44px 44px",
          }}
          aria-hidden
        />
        {/* cursor spotlight */}
        <Box ref={spotRef} position="fixed" inset="0" zIndex="1" pointerEvents="none" aria-hidden />

        <Box position="relative" zIndex="2">
          <VoltNav />
          <Hero />
          <Services />
          <ScoreGauge />
          <Banner />
          <Process />
          <CaptionLab />
          <Pricing />
          <VoltFooter />
          <VariantDial />
        </Box>
      </Box>
    </SmoothScroll>
  );
}
