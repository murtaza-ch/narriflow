"use client";

import { useRef } from "react";
import Link from "next/link";
import { Box, chakra, Flex, Grid, HStack, Stack, Text } from "@chakra-ui/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { SmoothScroll } from "../../_components/smooth-scroll";
import { VariantDial } from "../../_components/variant-dial";
import {
  CAPTION_PRESETS,
  PIPELINE,
  PLATFORMS,
  REPURPOSE_FORMATS,
  STATS,
  TIERS,
} from "../../_components/landing-data";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
}

/* Signal palette — marketing-variant hexes allowed per design brief. */
const PORCELAIN = "#FBFBFC";
const INK = "#101318";
const ULTRA = "#2438E8";
const GREEN = "#00FF88";
const HAIR = "rgba(16, 19, 24, 0.14)";

/* Deterministic sticker-chip rotations — no Math.random (SSR hydration). */
const CHIP_ROTS = [-3, 2.5, -2, 3, -1.5, 2, -2.5, 1.5, -3, 2, -1, 2.5];

/* ------------------------------ angled marquee ----------------------------- */

function AngledMarquee({
  angle,
  bg,
  speed,
  starColor,
  items,
}: {
  angle: number;
  bg: string;
  speed: number;
  starColor: string;
  items: ReadonlyArray<{ label: string; color: string }>;
}) {
  return (
    <Box overflow="hidden" py={{ base: "6", md: "9" }} aria-hidden>
      <Box
        transform={`rotate(${angle}deg)`}
        w="112%"
        ml="-6%"
        bg={bg}
        py={{ base: "3.5", md: "4" }}
        overflow="hidden"
        whiteSpace="nowrap"
      >
        <Box display="inline-flex" data-marquee-track data-speed={speed}>
          {[0, 1].map((dup) => (
            <HStack key={dup} gap={{ base: "6", md: "10" }} pr={{ base: "6", md: "10" }} flexShrink={0}>
              {items.map((it) => (
                <HStack key={`${dup}-${it.label}`} gap={{ base: "6", md: "10" }} flexShrink={0}>
                  <Text
                    fontFamily="mono"
                    fontWeight="500"
                    fontSize={{ base: "12px", md: "14px" }}
                    letterSpacing="0.16em"
                    style={{ color: it.color }}
                  >
                    {it.label}
                  </Text>
                  <Text fontSize="11px" style={{ color: starColor }}>
                    ✦
                  </Text>
                </HStack>
              ))}
            </HStack>
          ))}
        </Box>
      </Box>
    </Box>
  );
}

/* ---------------------------------- nav ------------------------------------ */

function SignalNav() {
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
      bg={PORCELAIN}
      borderBottom={`1px solid ${HAIR}`}
    >
      <Link href="/" aria-label="Narriflow home">
        <Logo size="md" />
      </Link>
      <Button size="sm" asChild>
        <Link href="/sign-up">Start free</Link>
      </Button>
    </Flex>
  );
}

/* --------------------------------- hero ------------------------------------ */

const HERO_LINE_1 = ["LONG", "VIDEO", "IN."];
const HERO_LINE_2 = ["THIRTY", "POSTS", "OUT."];

function SlamLine({ words, color }: { words: readonly string[]; color: string }) {
  return (
    <Box display="block">
      {words.map((word, i) => (
        <Box
          as="span"
          key={i}
          display="inline-block"
          overflow="hidden"
          verticalAlign="top"
          mr="0.22em"
          _last={{ mr: "0" }}
        >
          <Box as="span" display="inline-block" data-slam-word style={{ opacity: 0, color }}>
            {word}
          </Box>
        </Box>
      ))}
    </Box>
  );
}

function Hero() {
  const presetItems = CAPTION_PRESETS.map((p) => ({ label: p.name.toUpperCase(), color: p.accent }));

  return (
    <Box
      data-hero
      position="relative"
      minH="100svh"
      pt="60px"
      display="flex"
      flexDirection="column"
      overflow="hidden"
      bg={PORCELAIN}
    >
      {/* floating stickers */}
      <Box
        data-sticker
        data-speed="1.4"
        aria-hidden
        position="absolute"
        top={{ base: "13%", md: "17%" }}
        right={{ base: "5%", md: "9%" }}
        transform="rotate(6deg)"
        bg={ULTRA}
        color={PORCELAIN}
        borderRadius="20px"
        px={{ base: "4", md: "5" }}
        py={{ base: "3", md: "4" }}
        textAlign="center"
        zIndex="1"
        pointerEvents="none"
        style={{ opacity: 0 }}
      >
        <Text fontFamily="mono" fontWeight="600" fontSize={{ base: "28px", md: "40px" }} lineHeight="1">
          92
        </Text>
        <Text fontFamily="mono" fontSize="10px" letterSpacing="0.22em" mt="1">
          SCORE
        </Text>
      </Box>
      <Box
        data-sticker
        data-speed="0.9"
        aria-hidden
        display={{ base: "none", md: "block" }}
        position="absolute"
        bottom={{ base: "32%", md: "34%" }}
        left={{ base: "4%", md: "6%" }}
        transform="rotate(-6deg)"
        bg={GREEN}
        color={INK}
        px="4"
        py="2"
        borderRadius="10px"
        zIndex="1"
        pointerEvents="none"
        style={{ opacity: 0 }}
      >
        <Text fontFamily="mono" fontWeight="700" fontSize={{ base: "16px", md: "20px" }} letterSpacing="0.08em">
          9:16
        </Text>
      </Box>
      <Box
        data-sticker
        data-speed="1.8"
        aria-hidden
        display={{ base: "none", md: "flex" }}
        position="absolute"
        top="22%"
        left="11%"
        transform="rotate(8deg)"
        bg={PORCELAIN}
        border={`1.5px solid ${INK}`}
        borderRadius="full"
        boxSize="76px"
        alignItems="center"
        justifyContent="center"
        fontSize="34px"
        zIndex="1"
        pointerEvents="none"
        style={{ opacity: 0 }}
      >
        🔥
      </Box>
      <Box
        data-sticker
        data-speed="1.1"
        aria-hidden
        display={{ base: "none", md: "block" }}
        position="absolute"
        bottom="27%"
        right="7%"
        transform="rotate(-3deg)"
        bg={INK}
        color={PORCELAIN}
        px="4"
        py="2.5"
        borderRadius="10px"
        zIndex="1"
        pointerEvents="none"
        style={{ opacity: 0 }}
      >
        <Text fontFamily="mono" fontSize={{ base: "13px", md: "15px" }} letterSpacing="0.06em">
          47:12 → 0:34
        </Text>
      </Box>

      {/* poster headline */}
      <Flex
        flex="1"
        direction="column"
        justify="center"
        align="center"
        textAlign="center"
        px={{ base: "4", md: "10" }}
        pt={{ base: "10", md: "6" }}
        position="relative"
        zIndex="2"
      >
        <Text
          data-hero-eyebrow
          fontFamily="mono"
          fontSize={{ base: "11px", md: "13px" }}
          letterSpacing="0.28em"
          color={INK}
          style={{ opacity: 0 }}
        >
          AI CLIPPING ✦ REPURPOSING ✦ PUBLISHING
        </Text>
        <Box
          as="h1"
          mt={{ base: "5", md: "6" }}
          fontFamily="display"
          fontWeight="800"
          letterSpacing="-0.03em"
          lineHeight="0.94"
          fontSize="clamp(46px, 12vw, 168px)"
          color={INK}
        >
          <SlamLine words={HERO_LINE_1} color={INK} />
          <SlamLine words={HERO_LINE_2} color={ULTRA} />
        </Box>
        <Text
          data-hero-sub
          mt={{ base: "6", md: "8" }}
          fontSize={{ base: "15px", md: "17px" }}
          color="rgba(16,19,24,0.72)"
          lineHeight="1.65"
          maxW="46ch"
          style={{ opacity: 0 }}
        >
          Narriflow ingests the recording, finds the moments, burns the captions and hands
          you the winners — every clip scored for virality before you hit render.
        </Text>
        <HStack mt={{ base: "7", md: "9" }} gap="4" data-hero-cta style={{ opacity: 0 }}>
          <Link href="/sign-up">
            <Flex
              bg={INK}
              color={PORCELAIN}
              px={{ base: "6", md: "8" }}
              py={{ base: "3", md: "3.5" }}
              borderRadius="12px"
              fontFamily="display"
              fontWeight="700"
              fontSize={{ base: "14px", md: "16px" }}
              align="center"
              transition="transform 180ms cubic-bezier(0.22,1,0.36,1), background 180ms ease"
              _hover={{ transform: "translateY(-2px) rotate(-1deg)", bg: ULTRA }}
            >
              Start for free
            </Flex>
          </Link>
          <Link href="#machine">
            <Text
              fontFamily="mono"
              fontSize={{ base: "12px", md: "13px" }}
              letterSpacing="0.14em"
              color={INK}
              borderBottom={`1.5px solid ${INK}`}
              pb="1"
              transition="color 160ms ease, border-color 160ms ease"
              _hover={{ color: ULTRA, borderColor: ULTRA }}
            >
              SEE THE MACHINE ↓
            </Text>
          </Link>
        </HStack>
      </Flex>

      {/* angled caption-preset marquee bleeding into the ink section */}
      <Box position="relative" zIndex="3" mb={{ base: "-12", md: "-16" }}>
        <AngledMarquee angle={-2} bg={INK} speed={30} starColor={PORCELAIN} items={presetItems} />
      </Box>
    </Box>
  );
}

/* ----------------------------- phone / captions ---------------------------- */

function PhoneSection() {
  return (
    <Box data-phone-section bg={INK} color={PORCELAIN} pt={{ base: "28", md: "40" }} pb={{ base: "20", md: "32" }} overflow="hidden">
      <Grid
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        templateColumns={{ base: "1fr", lg: "380px 1fr" }}
        gap={{ base: "14", lg: "24" }}
        alignItems="center"
      >
        {/* phone frame — straightens on scroll */}
        <Box justifySelf="center" w={{ base: "240px", md: "300px" }}>
          <Box
            data-phone
            borderWidth="1.5px"
            borderColor="rgba(251,251,252,0.35)"
            borderRadius="38px"
            p="2.5"
            bg="rgba(0,0,0,0.45)"
            boxShadow="0 50px 120px rgba(0,0,0,0.6)"
            style={{ transform: "rotate(-6deg) scale(0.92)" }}
          >
            <chakra.video
              src="/videos/caption-loop.mp4"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              w="full"
              borderRadius="28px"
              display="block"
            />
          </Box>
        </Box>

        <Stack gap={{ base: "7", md: "9" }}>
          <Text
            as="h2"
            data-reveal
            fontFamily="display"
            fontWeight="800"
            textTransform="uppercase"
            letterSpacing="-0.025em"
            lineHeight="0.98"
            fontSize="clamp(34px, 6vw, 84px)"
          >
            Captions that hit{" "}
            <Box as="span" style={{ color: GREEN }}>
              on every word.
            </Box>
          </Text>
          <Text data-reveal fontSize={{ base: "15px", md: "16.5px" }} color="rgba(251,251,252,0.72)" lineHeight="1.7" maxW="52ch">
            One cue model drives both the editor preview and the final burn-in — what you
            see is exactly what renders, word for word, emoji for emoji.
          </Text>

          {/* preset sticker-chips */}
          <Flex data-reveal gap={{ base: "2.5", md: "3" }} flexWrap="wrap">
            {CAPTION_PRESETS.map((p, i) => (
              <Box
                key={p.name}
                px="3.5"
                py="2"
                borderRadius="10px"
                borderWidth="1.5px"
                transform={`rotate(${CHIP_ROTS[i % CHIP_ROTS.length]}deg)`}
                transition="transform 200ms cubic-bezier(0.22,1,0.36,1)"
                _hover={{ transform: "rotate(0deg) translateY(-3px)" }}
                style={{ borderColor: p.accent }}
              >
                <Text fontFamily="mono" fontWeight="600" fontSize="12.5px" letterSpacing="0.08em" style={{ color: p.accent }}>
                  {p.name.toUpperCase()}
                </Text>
              </Box>
            ))}
          </Flex>

          <Text data-reveal fontFamily="mono" fontSize="12px" letterSpacing="0.18em" color="rgba(251,251,252,0.5)">
            12 PRESETS · 9 ANIMATION STYLES · EMOJI CAPTIONS 💰🔥📈
          </Text>
        </Stack>
      </Grid>
    </Box>
  );
}

/* ----------------------------- score odometer ------------------------------ */

function ScoreSection() {
  return (
    <Box data-score bg={ULTRA} color={PORCELAIN}>
      <Flex
        data-score-pin
        minH="100vh"
        direction="column"
        align="center"
        justify="center"
        position="relative"
        overflow="hidden"
        textAlign="center"
        px="5"
      >
        {/* drifting ghost rows */}
        <Stack aria-hidden position="absolute" inset="0" justify="center" gap="0" pointerEvents="none" userSelect="none">
          {[0, 1, 2].map((row) => (
            <Text
              key={row}
              data-drift={row % 2 === 0 ? "l" : "r"}
              fontFamily="display"
              fontWeight="800"
              whiteSpace="nowrap"
              lineHeight="1.05"
              fontSize="clamp(64px, 13vw, 180px)"
              color="rgba(251,251,252,0.07)"
              alignSelf="center"
            >
              {Array.from({ length: 10 }, () => "SCORE").join(" ✦ ")}
            </Text>
          ))}
        </Stack>

        <Box position="relative" zIndex="1">
          <Text fontFamily="mono" fontSize={{ base: "11px", md: "13px" }} letterSpacing="0.32em">
            VIRALITY SCORE
          </Text>
          <Box position="relative" display="inline-block">
            <Text
              data-score-num
              aria-hidden
              fontFamily="mono"
              fontWeight="600"
              lineHeight="0.95"
              fontSize="clamp(160px, 30vw, 440px)"
              css={{ fontVariantNumeric: "tabular-nums" }}
            >
              0
            </Text>
            {/* render stamp */}
            <Flex
              data-score-stamp
              aria-hidden
              position="absolute"
              right={{ base: "-8%", md: "-14%" }}
              bottom={{ base: "6%", md: "10%" }}
              transform="rotate(-8deg)"
              bg={GREEN}
              color={INK}
              px={{ base: "3.5", md: "5" }}
              py={{ base: "2", md: "3" }}
              borderRadius="10px"
              align="center"
              gap="2"
              boxShadow="0 20px 60px rgba(0,0,0,0.35)"
              style={{ opacity: 0 }}
            >
              <Text fontFamily="mono" fontWeight="700" fontSize={{ base: "13px", md: "18px" }} letterSpacing="0.1em">
                ✓ RENDER
              </Text>
            </Flex>
          </Box>
          <Text
            as="h2"
            mt={{ base: "4", md: "2" }}
            fontFamily="display"
            fontWeight="700"
            letterSpacing="-0.02em"
            fontSize={{ base: "20px", md: "30px" }}
            maxW="24ch"
            mx="auto"
          >
            We rank every moment. You post the winners.
          </Text>
        </Box>
      </Flex>
    </Box>
  );
}

/* --------------------------- pipeline poster list --------------------------- */

function PipelinePoster() {
  return (
    <Box id="machine" bg={PORCELAIN} py={{ base: "20", md: "32" }} css={{ scrollMarginTop: "60px" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <Stack gap="3" data-reveal>
          <HStack gap="4">
            <Box h="2px" w="10" bg={INK} />
            <Text fontFamily="mono" fontSize="12px" letterSpacing="0.28em" color={INK}>
              THE MACHINE
            </Text>
          </HStack>
          <Text
            as="h2"
            fontFamily="display"
            fontWeight="800"
            textTransform="uppercase"
            letterSpacing="-0.02em"
            fontSize={{ base: "26px", md: "40px" }}
            color={INK}
          >
            Feed it once. It does the rest.
          </Text>
        </Stack>

        <Stack gap="0" mt={{ base: "10", md: "16" }}>
          {PIPELINE.map((s) => (
            <Box
              key={s.key}
              data-fill-row
              py={{ base: "6", md: "9" }}
              borderTop={`1px solid ${HAIR}`}
              _last={{ borderBottom: `1px solid ${HAIR}` }}
            >
              <Flex align="baseline" gap={{ base: "4", md: "8" }} flexWrap="wrap">
                <Text fontFamily="mono" fontSize={{ base: "13px", md: "15px" }} color={ULTRA} w={{ base: "8", md: "12" }}>
                  {s.n}
                </Text>
                <Box position="relative" flex="1" minW="0">
                  <Text
                    as="h3"
                    fontFamily="display"
                    fontWeight="800"
                    textTransform="uppercase"
                    letterSpacing="-0.02em"
                    lineHeight="1"
                    fontSize="clamp(34px, 7vw, 92px)"
                    color="transparent"
                    css={{ WebkitTextStroke: `1.5px ${INK}` }}
                  >
                    {s.title}
                  </Text>
                  <Text
                    aria-hidden
                    data-fill-text
                    position="absolute"
                    inset="0"
                    fontFamily="display"
                    fontWeight="800"
                    textTransform="uppercase"
                    letterSpacing="-0.02em"
                    lineHeight="1"
                    fontSize="clamp(34px, 7vw, 92px)"
                    color={INK}
                    style={{ clipPath: "inset(0% 100% 0% 0%)" }}
                  >
                    {s.title}
                  </Text>
                </Box>
                <Text
                  fontFamily="mono"
                  fontSize={{ base: "11px", md: "13px" }}
                  letterSpacing="0.1em"
                  color="rgba(16,19,24,0.55)"
                  textAlign="right"
                  ml="auto"
                >
                  {s.meta}
                </Text>
              </Flex>
              <Text
                mt="3"
                ml={{ base: "0", md: "20" }}
                fontSize={{ base: "14px", md: "15px" }}
                color="rgba(16,19,24,0.66)"
                lineHeight="1.65"
                maxW="62ch"
              >
                {s.body}
              </Text>
            </Box>
          ))}
        </Stack>
      </Box>
    </Box>
  );
}

/* ------------------------------ repurpose burst ----------------------------- */

function RepurposeBurst() {
  return (
    <Box data-repurpose bg={INK} color={PORCELAIN} py={{ base: "20", md: "32" }} overflow="hidden">
      <Box maxW="1400px" mx="auto" px={{ base: "5", md: "10" }}>
        <Flex
          as="h2"
          align="center"
          justify="center"
          gap={{ base: "5", md: "10" }}
          direction={{ base: "column", md: "row" }}
        >
          <Text
            as="span"
            data-slide-left
            fontFamily="display"
            fontWeight="800"
            textTransform="uppercase"
            letterSpacing="-0.02em"
            lineHeight="0.95"
            fontSize="clamp(40px, 7.5vw, 120px)"
            color="transparent"
            whiteSpace="nowrap"
            css={{ WebkitTextStroke: `1.5px ${PORCELAIN}` }}
          >
            One in
          </Text>
          <Box
            as="span"
            display="block"
            w={{ base: "240px", md: "320px" }}
            flexShrink={0}
            borderWidth="1.5px"
            borderColor="rgba(251,251,252,0.28)"
            borderRadius="20px"
            p="2.5"
            bg="rgba(0,0,0,0.4)"
          >
            <chakra.video
              src="/videos/repurpose-burst.mp4"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              w="full"
              borderRadius="14px"
              display="block"
            />
          </Box>
          <Text
            as="span"
            data-slide-right
            fontFamily="display"
            fontWeight="800"
            textTransform="uppercase"
            letterSpacing="-0.02em"
            lineHeight="0.95"
            fontSize="clamp(40px, 7.5vw, 120px)"
            color="transparent"
            whiteSpace="nowrap"
            css={{ WebkitTextStroke: `1.5px ${PORCELAIN}` }}
          >
            Five out
          </Text>
        </Flex>

        <Text
          data-reveal
          mt={{ base: "10", md: "14" }}
          textAlign="center"
          fontSize={{ base: "14.5px", md: "16px" }}
          color="rgba(251,251,252,0.68)"
          maxW="56ch"
          mx="auto"
          lineHeight="1.7"
        >
          The same word-level transcript that cuts your clips writes the rest of the
          week&apos;s content — structured, editable, ready to schedule.
        </Text>

        <Flex mt={{ base: "8", md: "12" }} gap={{ base: "3", md: "4" }} flexWrap="wrap" justify="center">
          {REPURPOSE_FORMATS.map((f, i) => (
            <Flex
              key={f.name}
              data-reveal
              direction="column"
              gap="1.5"
              px={{ base: "5", md: "7" }}
              py={{ base: "4", md: "5" }}
              borderWidth="1.5px"
              borderColor="rgba(251,251,252,0.3)"
              borderRadius="14px"
              transform={`rotate(${CHIP_ROTS[(i + 3) % CHIP_ROTS.length]}deg)`}
              transition="transform 220ms cubic-bezier(0.22,1,0.36,1), border-color 220ms ease"
              _hover={{ transform: "rotate(0deg) translateY(-4px)", borderColor: GREEN }}
            >
              <Text
                fontFamily="display"
                fontWeight="800"
                textTransform="uppercase"
                fontSize={{ base: "18px", md: "24px" }}
                letterSpacing="-0.01em"
              >
                {f.name}
              </Text>
              <Text fontFamily="mono" fontSize="11.5px" letterSpacing="0.06em" color="rgba(251,251,252,0.55)">
                {f.detail}
              </Text>
            </Flex>
          ))}
        </Flex>
      </Box>
    </Box>
  );
}

/* -------------------------------- stats slam -------------------------------- */

function StatsSlam() {
  return (
    <Box bg={PORCELAIN} py={{ base: "16", md: "24" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <Text data-reveal fontFamily="mono" fontSize="12px" letterSpacing="0.28em" color={INK}>
          THE RECEIPTS ✦
        </Text>
        <Grid
          mt={{ base: "6", md: "8" }}
          templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }}
          borderTop={`1.5px solid ${INK}`}
          borderLeft={`1.5px solid ${INK}`}
        >
          {STATS.map((s) => (
            <Stack
              key={s.label}
              data-reveal
              py={{ base: "8", md: "12" }}
              px={{ base: "4", md: "6" }}
              gap="2"
              borderRight={`1.5px solid ${INK}`}
              borderBottom={`1.5px solid ${INK}`}
            >
              <Text
                fontFamily="mono"
                fontWeight="600"
                fontSize="clamp(40px, 6.5vw, 88px)"
                lineHeight="1"
                color={INK}
                css={{ fontVariantNumeric: "tabular-nums" }}
                data-count={s.value}
              >
                0
              </Text>
              <Text fontFamily="mono" fontSize="11px" letterSpacing="0.22em" color="rgba(16,19,24,0.6)">
                {s.label.toUpperCase()}
              </Text>
            </Stack>
          ))}
        </Grid>
      </Box>
    </Box>
  );
}

/* --------------------------------- pricing ---------------------------------- */

function PricingRows() {
  return (
    <Box bg={PORCELAIN} py={{ base: "20", md: "32" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <Stack gap="3" data-reveal>
          <HStack gap="4">
            <Box h="2px" w="10" bg={INK} />
            <Text fontFamily="mono" fontSize="12px" letterSpacing="0.28em" color={INK}>
              PRICING
            </Text>
          </HStack>
          <Text
            as="h2"
            fontFamily="display"
            fontWeight="800"
            textTransform="uppercase"
            letterSpacing="-0.02em"
            fontSize={{ base: "26px", md: "40px" }}
            color={INK}
          >
            A minute in is a minute metered.
          </Text>
        </Stack>
      </Box>

      <Stack gap="0" mt={{ base: "10", md: "14" }} borderTop={`1px solid ${HAIR}`}>
        {TIERS.map((t) => {
          const featured = t.featured;
          return (
            <Link key={t.name} href="/sign-up" style={{ display: "block" }}>
              <Box
                data-reveal
                role="group"
                bg={featured ? ULTRA : "transparent"}
                color={featured ? PORCELAIN : INK}
                borderBottom={featured ? "1px solid transparent" : `1px solid ${HAIR}`}
                transition="background 220ms ease"
                _hover={{ bg: featured ? ULTRA : "rgba(36,56,232,0.06)" }}
              >
                <Flex
                  maxW="1240px"
                  mx="auto"
                  px={{ base: "5", md: "10" }}
                  py={{ base: "7", md: "9" }}
                  align="center"
                  gap={{ base: "4", md: "10" }}
                  flexWrap="wrap"
                >
                  <Box flex={{ base: "1 1 100%", md: "0 0 auto" }} minW={{ md: "280px" }}>
                    {featured && (
                      <Text fontFamily="mono" fontSize="11px" letterSpacing="0.24em" mb="1.5" style={{ color: GREEN }}>
                        MOST POPULAR ✦
                      </Text>
                    )}
                    <Text
                      as="h3"
                      fontFamily="display"
                      fontWeight="800"
                      textTransform="uppercase"
                      letterSpacing="-0.02em"
                      lineHeight="1"
                      fontSize="clamp(30px, 5vw, 64px)"
                    >
                      {t.name}
                    </Text>
                  </Box>
                  <Text
                    fontFamily="mono"
                    fontWeight="600"
                    fontSize={{ base: "22px", md: "32px" }}
                    css={{ fontVariantNumeric: "tabular-nums" }}
                  >
                    ${t.price}
                    <Box as="span" fontSize={{ base: "12px", md: "14px" }} opacity={0.6}>
                      /mo
                    </Box>
                  </Text>
                  <Text
                    flex="1"
                    fontFamily="mono"
                    fontSize={{ base: "11.5px", md: "12.5px" }}
                    letterSpacing="0.04em"
                    lineHeight="1.7"
                    color={featured ? "rgba(251,251,252,0.85)" : "rgba(16,19,24,0.62)"}
                    minW={{ base: "100%", md: "auto" }}
                  >
                    {t.points.join("  ·  ")}
                  </Text>
                  <Flex
                    aria-hidden
                    boxSize={{ base: "44px", md: "56px" }}
                    borderRadius="full"
                    borderWidth="1.5px"
                    borderColor={featured ? PORCELAIN : INK}
                    align="center"
                    justify="center"
                    fontSize={{ base: "18px", md: "22px" }}
                    flexShrink={0}
                    transition="transform 220ms cubic-bezier(0.22,1,0.36,1), background 220ms ease, color 220ms ease"
                    _groupHover={{
                      transform: "translateX(6px)",
                      bg: featured ? PORCELAIN : INK,
                      color: featured ? ULTRA : PORCELAIN,
                    }}
                  >
                    →
                  </Flex>
                </Flex>
              </Box>
            </Link>
          );
        })}
      </Stack>
    </Box>
  );
}

/* ------------------------------- closing CTA -------------------------------- */

function ClosingCta() {
  const platformItems = PLATFORMS.map((p) => ({ label: p.toUpperCase(), color: PORCELAIN }));

  return (
    <Box bg={ULTRA} color={PORCELAIN} pt={{ base: "20", md: "32" }} overflow="hidden">
      <Stack align="center" textAlign="center" px="5" gap={{ base: "8", md: "10" }}>
        <Box
          as="h2"
          data-reveal
          fontFamily="display"
          fontWeight="800"
          textTransform="uppercase"
          letterSpacing="-0.03em"
          lineHeight="0.88"
          fontSize="clamp(64px, 16vw, 220px)"
        >
          <Box as="span" display="block">
            Post
          </Box>
          <Box as="span" display="block">
            Every
          </Box>
          <Box as="span" display="block">
            Day.
          </Box>
        </Box>
        <Stack data-reveal align="center" gap="4">
          <Link href="/sign-up">
            <Flex
              bg={INK}
              color={PORCELAIN}
              px={{ base: "8", md: "10" }}
              py={{ base: "3.5", md: "4" }}
              borderRadius="12px"
              fontFamily="display"
              fontWeight="700"
              fontSize={{ base: "15px", md: "17px" }}
              align="center"
              transition="transform 180ms cubic-bezier(0.22,1,0.36,1)"
              _hover={{ transform: "translateY(-2px) rotate(-1deg)" }}
            >
              Start for free
            </Flex>
          </Link>
          <Text fontFamily="mono" fontSize="12px" letterSpacing="0.2em" color="rgba(251,251,252,0.75)">
            FREE PLAN · NO CARD
          </Text>
        </Stack>
      </Stack>

      <Box mt={{ base: "12", md: "16" }} mb={{ base: "-10", md: "-12" }} position="relative" zIndex="2">
        <AngledMarquee angle={2} bg={INK} speed={24} starColor={GREEN} items={platformItems} />
      </Box>

      {/* footer bar */}
      <Flex
        bg={INK}
        pt={{ base: "16", md: "20" }}
        pb="6"
        px={{ base: "5", md: "10" }}
        justify="space-between"
        align="center"
        flexWrap="wrap"
        gap="3"
      >
        <Text fontFamily="mono" fontSize="11px" letterSpacing="0.18em" color="rgba(251,251,252,0.55)">
          © {new Date().getFullYear()} NARRIFLOW
        </Text>
        <HStack gap="6">
          <Link href="/privacy">
            <Text
              fontSize="12px"
              color="rgba(251,251,252,0.65)"
              transition="color 140ms ease"
              _hover={{ color: PORCELAIN }}
            >
              Privacy
            </Text>
          </Link>
          <Link href="/terms">
            <Text
              fontSize="12px"
              color="rgba(251,251,252,0.65)"
              transition="color 140ms ease"
              _hover={{ color: PORCELAIN }}
            >
              Terms
            </Text>
          </Link>
        </HStack>
      </Flex>
    </Box>
  );
}

/* ----------------------------------- page ----------------------------------- */

export function SignalClient() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

      if (reduced) {
        gsap.set(
          "[data-slam-word], [data-hero-eyebrow], [data-hero-sub], [data-hero-cta], [data-sticker], [data-reveal], [data-score-stamp]",
          { opacity: 1 },
        );
        gsap.set("[data-fill-text]", { clipPath: "inset(0% 0% 0% 0%)" });
        gsap.set("[data-phone]", { rotate: 0, scale: 1 });
        gsap.utils.toArray<HTMLElement>("[data-count]").forEach((el) => {
          el.textContent = Number(el.dataset.count).toLocaleString();
        });
        const num = document.querySelector("[data-score-num]");
        if (num) num.textContent = "92";
        return;
      }

      /* hero entrance */
      gsap
        .timeline({ defaults: { ease: "power4.out" } })
        .fromTo("[data-hero-eyebrow]", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6 })
        .fromTo(
          "[data-slam-word]",
          { yPercent: 112, opacity: 1 },
          { yPercent: 0, duration: 0.85, stagger: 0.07 },
          0.08,
        )
        .fromTo(
          "[data-sticker]",
          { opacity: 0, scale: 0.3 },
          { opacity: 1, scale: 1, duration: 0.7, ease: "back.out(2.2)", stagger: 0.09 },
          0.55,
        )
        .fromTo("[data-hero-sub]", { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.7 }, 0.62)
        .fromTo("[data-hero-cta]", { opacity: 0, y: 22 }, { opacity: 1, y: 0, duration: 0.7 }, 0.74);

      /* marquee tracks */
      gsap.utils.toArray<HTMLElement>("[data-marquee-track]").forEach((el) => {
        gsap.to(el, {
          xPercent: -50,
          duration: parseFloat(el.dataset.speed ?? "30"),
          ease: "none",
          repeat: -1,
        });
      });

      /* hero sticker parallax */
      gsap.utils.toArray<HTMLElement>("[data-sticker]").forEach((el) => {
        const speed = parseFloat(el.dataset.speed ?? "1");
        gsap.to(el, {
          yPercent: -34 * speed,
          ease: "none",
          scrollTrigger: { trigger: "[data-hero]", start: "top top", end: "bottom top", scrub: true },
        });
      });

      /* generic reveals */
      gsap.utils.toArray<HTMLElement>("[data-reveal]").forEach((el) => {
        gsap.fromTo(
          el,
          { autoAlpha: 0, y: 28 },
          {
            autoAlpha: 1,
            y: 0,
            duration: 0.85,
            ease: "power3.out",
            scrollTrigger: { trigger: el, start: "top 86%" },
          },
        );
      });

      /* stat counters */
      gsap.utils.toArray<HTMLElement>("[data-count]").forEach((el) => {
        const target = Number(el.dataset.count);
        const obj = { v: 0 };
        gsap.to(obj, {
          v: target,
          duration: 1.5,
          ease: "power2.out",
          scrollTrigger: { trigger: el, start: "top 85%" },
          onUpdate() {
            el.textContent = Math.round(obj.v).toLocaleString();
          },
        });
      });

      /* phone straightens + scales as it scrolls into view */
      gsap.fromTo(
        "[data-phone]",
        { rotate: -6, scale: 0.92, y: 46 },
        {
          rotate: 0,
          scale: 1,
          y: 0,
          ease: "none",
          scrollTrigger: {
            trigger: "[data-phone-section]",
            start: "top 85%",
            end: "center 45%",
            scrub: 0.4,
          },
        },
      );

      /* pinned virality-score odometer */
      const numEl = document.querySelector("[data-score-num]");
      const counter = { v: 0 };
      gsap
        .timeline({
          scrollTrigger: {
            trigger: "[data-score]",
            start: "top top",
            end: "+=220%",
            pin: "[data-score-pin]",
            scrub: 0.4,
          },
        })
        .to(counter, {
          v: 92,
          duration: 0.85,
          ease: "none",
          onUpdate() {
            if (numEl) numEl.textContent = String(Math.round(counter.v));
          },
        })
        .fromTo("[data-drift='l']", { xPercent: 6 }, { xPercent: -8, ease: "none", duration: 1 }, 0)
        .fromTo("[data-drift='r']", { xPercent: -6 }, { xPercent: 8, ease: "none", duration: 1 }, 0)
        .fromTo(
          "[data-score-stamp]",
          { opacity: 0, scale: 0.2, rotate: -22 },
          { opacity: 1, scale: 1, rotate: -8, duration: 0.15, ease: "back.out(2.5)" },
          0.85,
        );

      /* pipeline titles fill from outline to solid */
      gsap.utils.toArray<HTMLElement>("[data-fill-row]").forEach((row) => {
        const fill = row.querySelector("[data-fill-text]");
        if (!fill) return;
        gsap.fromTo(
          fill,
          { clipPath: "inset(0% 100% 0% 0%)" },
          {
            clipPath: "inset(0% 0% 0% 0%)",
            ease: "none",
            scrollTrigger: { trigger: row, start: "top 80%", end: "top 38%", scrub: true },
          },
        );
      });

      /* ONE IN / FIVE OUT slide apart */
      gsap.fromTo(
        "[data-slide-left]",
        { x: 60 },
        {
          x: -40,
          ease: "none",
          scrollTrigger: { trigger: "[data-repurpose]", start: "top 85%", end: "bottom 40%", scrub: true },
        },
      );
      gsap.fromTo(
        "[data-slide-right]",
        { x: -60 },
        {
          x: 40,
          ease: "none",
          scrollTrigger: { trigger: "[data-repurpose]", start: "top 85%", end: "bottom 40%", scrub: true },
        },
      );
    },
    { scope: rootRef },
  );

  return (
    <SmoothScroll>
      <Box ref={rootRef} className="light" bg={PORCELAIN} color={INK} minH="100vh">
        <SignalNav />
        <Hero />
        <PhoneSection />
        <ScoreSection />
        <PipelinePoster />
        <RepurposeBurst />
        <StatsSlam />
        <PricingRows />
        <ClosingCta />
        <VariantDial />
      </Box>
    </SmoothScroll>
  );
}
