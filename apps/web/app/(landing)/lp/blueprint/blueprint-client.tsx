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
  FEATURES,
  PIPELINE,
  REPURPOSE_FORMATS,
  STATS,
  TIERS,
} from "../../_components/landing-data";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
}

const CAPTION_WORDS = ["Stop", "scrubbing", "timelines", "by", "hand"];

const Video = chakra("video");

const NAV_LINKS: ReadonlyArray<readonly [string, string]> = [
  ["Pipeline", "#pipeline"],
  ["Features", "#features"],
  ["Captions", "#captions"],
  ["Pricing", "#pricing"],
];

/* ---------------------------------- nav ---------------------------------- */

function BlueprintNav() {
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
      borderColor="border"
      bg="bg/80"
      backdropFilter="blur(14px) saturate(1.3)"
      data-nav
    >
      <Link href="/" aria-label="Narriflow home">
        <Logo size="md" />
      </Link>
      <HStack gap="8" display={{ base: "none", md: "flex" }}>
        {NAV_LINKS.map(([label, href]) => (
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
        <Button variant="outline" size="sm" asChild>
          <Link href="/sign-up">Start free</Link>
        </Button>
      </HStack>
    </Flex>
  );
}

/* --------------------------------- hero ---------------------------------- */

function Hero() {
  return (
    <Box position="relative" pt={{ base: "120px", md: "150px" }} overflow="hidden">
      {/* blueprint grid backdrop */}
      <Box position="absolute" inset="0" layerStyle="blueprint" opacity="0.6" aria-hidden />
      <Box
        position="absolute"
        inset="0"
        bgGradient="to-b"
        gradientFrom="transparent"
        gradientTo="bg"
        aria-hidden
      />

      <Box position="relative" maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <HStack gap="4" data-hero-eyebrow style={{ opacity: 0 }}>
          <Box h="1.5px" w="9" bg="fg" />
          <Text textStyle="eyebrow" color="fg.subtle">
            AI clipping · repurposing · publishing
          </Text>
        </HStack>

        <Box
          as="h1"
          mt="6"
          fontFamily="display"
          fontWeight="700"
          letterSpacing="-0.035em"
          lineHeight="1.02"
          fontSize={{ base: "44px", md: "76px", lg: "92px" }}
          color="fg"
          maxW="17ch"
        >
          {"Every long recording hides thirty posts.".split(" ").map((word, i) => (
            <Box
              as="span"
              key={i}
              display="inline-block"
              overflow="hidden"
              verticalAlign="top"
              mr="0.24em"
            >
              <Box as="span" display="inline-block" data-hero-word style={{ opacity: 0 }}>
                {word === "thirty" ? (
                  <Box as="span" color="accent.fg">
                    {word}
                  </Box>
                ) : (
                  word
                )}
              </Box>
            </Box>
          ))}
        </Box>

        <Flex
          mt="8"
          gap={{ base: "8", lg: "16" }}
          direction={{ base: "column", lg: "row" }}
          align={{ base: "flex-start", lg: "flex-end" }}
          justify="space-between"
        >
          <Text
            data-hero-sub
            style={{ opacity: 0 }}
            fontSize={{ base: "15px", md: "17px" }}
            color="fg.muted"
            lineHeight="1.7"
            maxW="44ch"
          >
            Narriflow runs the whole pipeline — ingest, transcription, moment detection,
            captioned rendering, publishing — and hands you the clips worth posting,
            already scored for virality.
          </Text>
          <HStack gap="3" data-hero-cta style={{ opacity: 0 }}>
            <Button size="lg" px="7" asChild>
              <Link href="/sign-up">Start for free</Link>
            </Button>
            <Button variant="ghost" size="lg" asChild>
              <Link href="#pipeline">Watch it work ↓</Link>
            </Button>
          </HStack>
        </Flex>

        {/* drawn video frame */}
        <Box position="relative" mt={{ base: "12", md: "20" }} data-hero-video style={{ opacity: 0 }}>
          {/* corner ticks */}
          {[
            { top: "-10px", left: "-10px", borderTop: "1.5px solid", borderLeft: "1.5px solid" },
            { top: "-10px", right: "-10px", borderTop: "1.5px solid", borderRight: "1.5px solid" },
            { bottom: "-10px", left: "-10px", borderBottom: "1.5px solid", borderLeft: "1.5px solid" },
            { bottom: "-10px", right: "-10px", borderBottom: "1.5px solid", borderRight: "1.5px solid" },
          ].map((pos, i) => (
            <Box key={i} position="absolute" boxSize="26px" color="fg" borderColor="fg" {...pos} aria-hidden />
          ))}
          <Box
            layerStyle="well"
            p={{ base: "2", md: "3" }}
            borderRadius="l3"
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
              borderRadius="l2"
              display="block"
            />
          </Box>
          <Flex mt="3" justify="space-between" px="1">
            <Text textStyle="data" fontSize="12px" color="fg.timecode">
              FIG. 01 — MOMENT DETECTION
            </Text>
            <Text textStyle="data" fontSize="12px" color="fg.subtle">
              00:00:12.00 LOOP
            </Text>
          </Flex>
        </Box>
      </Box>
    </Box>
  );
}

/* -------------------------------- marquee -------------------------------- */

const MARQUEE_ITEMS = [
  "WORD-ACCURATE CAPTIONS",
  "VIRALITY-SCORED CLIPS",
  "9:16 · 1:1 · 16:9 · 4:5",
  "AUTO-REFRAME",
  "12 CAPTION PRESETS",
  "RSS AUTOPILOT",
  "AI DUBBING",
  "DIRECT PUBLISHING",
];

function Marquee() {
  return (
    <Box
      mt={{ base: "16", md: "24" }}
      borderYWidth="1.5px"
      borderColor="fg"
      py="4"
      overflow="hidden"
      whiteSpace="nowrap"
    >
      <Box display="inline-flex" data-marquee>
        {[0, 1].map((dup) => (
          <HStack key={dup} gap="10" pr="10" aria-hidden={dup === 1}>
            {MARQUEE_ITEMS.map((item) => (
              <HStack key={item} gap="10" flexShrink={0}>
                <Text textStyle="data" fontSize="13px" color="fg" letterSpacing="0.12em">
                  {item}
                </Text>
                <Box boxSize="5px" bg="accent.solid" borderRadius="full" />
              </HStack>
            ))}
          </HStack>
        ))}
      </Box>
    </Box>
  );
}

/* ----------------------------- pinned pipeline ---------------------------- */

function Pipeline() {
  const [stage, setStage] = useState(0);

  return (
    <Box id="pipeline" data-pipeline position="relative" bg="bg" css={{ scrollMarginTop: "60px" }}>
      <Box data-pipeline-pin minH="100vh" display="flex" flexDirection="column" justifyContent="center" py="16">
        <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }} w="full">
          <Stack layerStyle="band" gap="3" maxW="640px">
            <Text textStyle="eyebrow" color="fg.subtle">
              The pipeline
            </Text>
            <Text
              fontFamily="display"
              fontWeight="700"
              letterSpacing="-0.03em"
              fontSize={{ base: "30px", md: "44px" }}
              color="fg"
            >
              One workflow, five machines.
            </Text>
          </Stack>

          <Grid
            mt={{ base: "10", md: "16" }}
            templateColumns={{ base: "1fr", md: "220px 1fr" }}
            gap={{ base: "8", md: "16" }}
            alignItems="start"
          >
            {/* giant stage number */}
            <Box position="relative" h={{ base: "90px", md: "260px" }} overflow="hidden">
              {PIPELINE.map((s, i) => (
                <Text
                  key={s.key}
                  position="absolute"
                  top="0"
                  left="0"
                  fontFamily="display"
                  fontWeight="700"
                  letterSpacing="-0.05em"
                  lineHeight="0.9"
                  fontSize={{ base: "80px", md: "220px" }}
                  color={i === stage ? "accent.fg" : "transparent"}
                  opacity={i === stage ? 1 : 0}
                  transform={i === stage ? "translateY(0)" : i < stage ? "translateY(-40px)" : "translateY(40px)"}
                  transition="opacity 380ms cubic-bezier(0.22,1,0.36,1), transform 380ms cubic-bezier(0.22,1,0.36,1)"
                  aria-hidden={i !== stage}
                >
                  {s.n}
                </Text>
              ))}
            </Box>

            {/* stage rows */}
            <Stack gap="0">
              {PIPELINE.map((s, i) => {
                const active = i === stage;
                return (
                  <Flex
                    key={s.key}
                    py={{ base: "4", md: "5" }}
                    gap={{ base: "4", md: "10" }}
                    align="baseline"
                    borderTopWidth="1px"
                    borderColor={active ? "fg" : "border"}
                    transition="border-color 300ms ease"
                    opacity={active ? 1 : 0.38}
                    css={{ transitionProperty: "border-color, opacity", transitionDuration: "300ms" }}
                  >
                    <Text textStyle="data" fontSize="13px" color={active ? "fg.timecode" : "fg.subtle"} w="9">
                      {s.n}
                    </Text>
                    <Box flex="1">
                      <Flex align="baseline" justify="space-between" gap="4" flexWrap="wrap">
                        <Text
                          fontFamily="display"
                          fontWeight="650"
                          letterSpacing="-0.02em"
                          fontSize={{ base: "20px", md: "26px" }}
                          color="fg"
                        >
                          {s.title}
                        </Text>
                        <Text textStyle="data" fontSize="12px" color={active ? "accent.fg" : "fg.subtle"}>
                          {s.meta}
                        </Text>
                      </Flex>
                      <Box
                        display="grid"
                        gridTemplateRows={active ? "1fr" : "0fr"}
                        transition="grid-template-rows 380ms cubic-bezier(0.22,1,0.36,1)"
                      >
                        <Box overflow="hidden">
                          <Text pt="2" fontSize="14.5px" color="fg.muted" lineHeight="1.65" maxW="60ch">
                            {s.body}
                          </Text>
                        </Box>
                      </Box>
                    </Box>
                  </Flex>
                );
              })}

              {/* progress rule */}
              <Box mt="6" h="3px" bg="bg.muted" position="relative" borderRadius="full" overflow="hidden">
                <Box
                  data-pipeline-progress
                  position="absolute"
                  insetY="0"
                  left="0"
                  w="full"
                  bg="accent.solid"
                  transformOrigin="left"
                  style={{ transform: "scaleX(0)" }}
                />
              </Box>
            </Stack>
          </Grid>
        </Box>
      </Box>

      {/* invisible driver reads scroll progress into React state */}
      <PipelineDriver onStage={setStage} />
    </Box>
  );
}

function PipelineDriver({ onStage }: { onStage: (s: number) => void }) {
  useGSAP(() => {
    const trigger = document.querySelector("[data-pipeline]");
    const pin = document.querySelector("[data-pipeline-pin]");
    const progress = document.querySelector("[data-pipeline-progress]");
    if (!trigger || !pin || !progress) return;

    ScrollTrigger.create({
      trigger,
      start: "top top",
      end: "+=320%",
      pin,
      scrub: 0.4,
      onUpdate(self) {
        onStage(Math.min(PIPELINE.length - 1, Math.floor(self.progress * PIPELINE.length)));
        gsap.set(progress, { scaleX: self.progress });
      },
    });
  });
  return null;
}

/* -------------------------------- stat band ------------------------------- */

function StatBand() {
  return (
    <Box borderYWidth="1.5px" borderColor="fg" bg="bg.subtle">
      <Grid
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }}
      >
        {STATS.map((s, i) => (
          <Stack
            key={s.label}
            py={{ base: "8", md: "12" }}
            px={{ base: "2", md: "6" }}
            gap="2"
            borderLeftWidth={{ base: i % 2 === 1 ? "1px" : "0", md: i > 0 ? "1px" : "0" }}
            borderColor="border"
          >
            <Text
              textStyle="data"
              fontSize={{ base: "34px", md: "52px" }}
              fontWeight="600"
              color="fg"
              data-count={s.value}
            >
              0
            </Text>
            <Text textStyle="eyebrow" color="fg.subtle">
              {s.label}
            </Text>
          </Stack>
        ))}
      </Grid>
    </Box>
  );
}

/* -------------------------------- features -------------------------------- */

function Features() {
  return (
    <Box id="features" maxW="1240px" mx="auto" px={{ base: "5", md: "10" }} py={{ base: "20", md: "32" }} css={{ scrollMarginTop: "60px" }}>
      <Stack layerStyle="band" gap="3" maxW="640px" data-reveal>
        <Text textStyle="eyebrow" color="fg.subtle">
          The toolkit
        </Text>
        <Text
          fontFamily="display"
          fontWeight="700"
          letterSpacing="-0.03em"
          fontSize={{ base: "30px", md: "44px" }}
          color="fg"
        >
          Built for the whole job, not just the cut.
        </Text>
      </Stack>

      <Grid
        mt={{ base: "10", md: "14" }}
        templateColumns={{ base: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" }}
        borderTopWidth="1px"
        borderLeftWidth="1px"
        borderColor="border"
      >
        {FEATURES.map((f, i) => (
          <GridItem
            key={f.key}
            data-reveal
            p={{ base: "6", md: "7" }}
            borderRightWidth="1px"
            borderBottomWidth="1px"
            borderColor="border"
            position="relative"
            role="group"
            transition="background 200ms ease"
            _hover={{ bg: "bg.subtle" }}
          >
            <Box
              position="absolute"
              top="0"
              left="0"
              h="3px"
              w="0"
              bg="accent.solid"
              transition="width 260ms cubic-bezier(0.22,1,0.36,1)"
              _groupHover={{ w: "full" }}
            />
            <Text textStyle="data" fontSize="12px" color="fg.subtle">
              {String(i + 1).padStart(2, "0")}
            </Text>
            <Text
              mt="10"
              fontFamily="display"
              fontWeight="650"
              letterSpacing="-0.01em"
              fontSize="17px"
              color="fg"
            >
              {f.title}
            </Text>
            <Text mt="2.5" fontSize="13.5px" color="fg.muted" lineHeight="1.65">
              {f.body}
            </Text>
          </GridItem>
        ))}
      </Grid>
    </Box>
  );
}

/* ----------------------------- caption playground ------------------------- */

function CaptionPlayground() {
  const [preset, setPreset] = useState(0);
  const [word, setWord] = useState(0);

  useEffect(() => {
    const id = window.setInterval(() => {
      setWord((w) => (w + 1) % (CAPTION_WORDS.length + 1));
    }, 420);
    return () => window.clearInterval(id);
  }, []);

  const activePreset = CAPTION_PRESETS[preset] ?? CAPTION_PRESETS[0];
  const accent = activePreset.accent;

  return (
    <Box bg="bg.inverted" color="fg.inverted" py={{ base: "20", md: "32" }} id="captions" css={{ scrollMarginTop: "60px" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <Grid templateColumns={{ base: "1fr", lg: "1fr 420px" }} gap={{ base: "12", lg: "20" }} alignItems="center">
          <Stack gap="8">
            <Stack gap="3" data-reveal>
              <HStack gap="4">
                <Box h="1.5px" w="9" bg="fg.inverted" />
                <Text textStyle="eyebrow" color="whiteAlpha.600">
                  Caption studio
                </Text>
              </HStack>
              <Text
                fontFamily="display"
                fontWeight="700"
                letterSpacing="-0.03em"
                fontSize={{ base: "30px", md: "44px" }}
                lineHeight="1.08"
              >
                The preview is the export.
                <br />
                Word for word.
              </Text>
              <Text fontSize="15px" color="whiteAlpha.700" lineHeight="1.7" maxW="52ch">
                One cue model drives both the editor preview and the final burn-in, so what
                you see is exactly what renders. Twelve presets, nine animation styles,
                emoji captions — try one:
              </Text>
            </Stack>

            {/* preset chips */}
            <Flex gap="2" flexWrap="wrap" data-reveal>
              {CAPTION_PRESETS.map((p, i) => (
                <Box
                  key={p.name}
                  as="button"
                  onClick={() => setPreset(i)}
                  px="3.5"
                  py="2"
                  borderRadius="full"
                  borderWidth="1.5px"
                  borderColor={i === preset ? p.accent : "whiteAlpha.300"}
                  bg={i === preset ? `${p.accent}1A` : "transparent"}
                  transition="border-color 160ms ease, background 160ms ease, transform 160ms ease"
                  _hover={{ borderColor: p.accent, transform: "translateY(-1px)" }}
                  cursor="pointer"
                >
                  <HStack gap="2">
                    <Box boxSize="8px" borderRadius="full" style={{ background: p.accent }} />
                    <Text fontSize="12.5px" fontWeight="600" color="fg.inverted">
                      {p.name}
                    </Text>
                  </HStack>
                </Box>
              ))}
            </Flex>

            {/* live caption line */}
            <Box
              data-reveal
              borderWidth="1.5px"
              borderColor="whiteAlpha.300"
              borderRadius="l3"
              p={{ base: "8", md: "12" }}
              minH="150px"
              display="flex"
              alignItems="center"
              justifyContent="center"
              position="relative"
              overflow="hidden"
            >
              <Text textStyle="data" fontSize="11px" color="whiteAlpha.500" position="absolute" top="3" left="4">
                LIVE PREVIEW — {activePreset.name.toUpperCase()}
              </Text>
              <Flex gap="0.6em" flexWrap="wrap" justify="center">
                {CAPTION_WORDS.map((w, i) => {
                  const on = i === word;
                  const seen = i <= word;
                  return (
                    <Text
                      key={i}
                      fontFamily="display"
                      fontWeight="800"
                      textTransform="uppercase"
                      fontSize={{ base: "26px", md: "40px" }}
                      letterSpacing="-0.01em"
                      transition="color 120ms ease, transform 120ms ease"
                      style={{
                        color: on ? accent : seen ? "#FBFBFC" : "rgba(251,251,252,0.3)",
                        transform: on ? "scale(1.09)" : "scale(1)",
                      }}
                    >
                      {w}
                    </Text>
                  );
                })}
              </Flex>
            </Box>
          </Stack>

          {/* vertical caption video in device frame */}
          <Box data-reveal justifySelf={{ base: "center", lg: "end" }} w={{ base: "260px", md: "300px" }}>
            <Box
              borderWidth="1.5px"
              borderColor="whiteAlpha.400"
              borderRadius="34px"
              p="2.5"
              bg="blackAlpha.400"
              boxShadow="0 40px 100px rgba(0,0,0,0.5)"
            >
              <Video
                src="/videos/caption-loop.mp4"
                autoPlay
                muted
                loop
                playsInline
                preload="metadata"
                w="full"
                borderRadius="26px"
                display="block"
              />
            </Box>
            <Text mt="3" textAlign="center" textStyle="data" fontSize="12px" color="whiteAlpha.500">
              FIG. 02 — PRESETS, WORD-SYNCED
            </Text>
          </Box>
        </Grid>
      </Box>
    </Box>
  );
}

/* ------------------------------- repurposing ------------------------------ */

function Repurpose() {
  return (
    <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }} py={{ base: "20", md: "32" }}>
      <Grid templateColumns={{ base: "1fr", lg: "460px 1fr" }} gap={{ base: "12", lg: "24" }} alignItems="center">
        <Box data-reveal position="relative">
          <Box layerStyle="well" p="3" borderRadius="l3">
            <Video
              src="/videos/repurpose-burst.mp4"
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              w="full"
              borderRadius="l2"
              display="block"
            />
          </Box>
          <Text mt="3" textStyle="data" fontSize="12px" color="fg.timecode">
            FIG. 03 — ONE SOURCE, EVERY FORMAT
          </Text>
        </Box>

        <Stack gap="8">
          <Stack layerStyle="band" gap="3" data-reveal>
            <Text textStyle="eyebrow" color="fg.subtle">
              Content suite
            </Text>
            <Text
              fontFamily="display"
              fontWeight="700"
              letterSpacing="-0.03em"
              fontSize={{ base: "30px", md: "44px" }}
              color="fg"
              lineHeight="1.08"
            >
              The transcript keeps giving.
            </Text>
            <Text fontSize="15px" color="fg.muted" lineHeight="1.7" maxW="52ch">
              The same word-level transcript that cuts your clips also writes the rest of
              the week&apos;s content — structured, editable, and ready to schedule.
            </Text>
          </Stack>

          <Stack gap="0">
            {REPURPOSE_FORMATS.map((f, i) => (
              <Flex
                key={f.name}
                data-reveal
                py="4"
                gap="6"
                align="baseline"
                borderTopWidth="1px"
                borderColor="border"
                _last={{ borderBottomWidth: "1px" }}
                role="group"
                transition="padding-left 240ms cubic-bezier(0.22,1,0.36,1)"
                _hover={{ pl: "3" }}
              >
                <Text textStyle="data" fontSize="12px" color="fg.subtle" w="8">
                  {String(i + 1).padStart(2, "0")}
                </Text>
                <Text fontFamily="display" fontWeight="650" fontSize="19px" color="fg" flex="1">
                  {f.name}
                </Text>
                <Text fontSize="13px" color="fg.muted" display={{ base: "none", md: "block" }}>
                  {f.detail}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Stack>
      </Grid>
    </Box>
  );
}

/* --------------------------------- pricing -------------------------------- */

function Pricing() {
  return (
    <Box id="pricing" bg="bg.subtle" borderTopWidth="1.5px" borderColor="fg" py={{ base: "20", md: "32" }} css={{ scrollMarginTop: "60px" }}>
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }}>
        <Flex justify="space-between" align="flex-end" gap="8" flexWrap="wrap" data-reveal>
          <Stack layerStyle="band" gap="3" maxW="520px">
            <Text textStyle="eyebrow" color="fg.subtle">
              Pricing
            </Text>
            <Text
              fontFamily="display"
              fontWeight="700"
              letterSpacing="-0.03em"
              fontSize={{ base: "30px", md: "44px" }}
              color="fg"
            >
              A minute in is a minute metered.
            </Text>
          </Stack>
          <Text fontSize="14px" color="fg.muted" maxW="36ch" lineHeight="1.65">
            One honest metric: a minute of source media equals one processing minute. No
            credit math.
          </Text>
        </Flex>

        <Grid
          mt={{ base: "10", md: "14" }}
          templateColumns={{ base: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" }}
          gap="0"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
        >
          {TIERS.map((t, i) => (
            <Stack
              key={t.name}
              data-reveal
              p={{ base: "7", md: "8" }}
              gap="5"
              borderLeftWidth={{ base: "0", lg: i > 0 ? "1px" : "0" }}
              borderTopWidth={{ base: i > 0 ? "1px" : "0", lg: "0" }}
              borderColor="border"
              position="relative"
              bg={t.featured ? "bg" : "transparent"}
            >
              {t.featured && <Box position="absolute" top="-1px" insetX="-1px" h="3px" bg="accent.solid" />}
              <Flex justify="space-between" align="baseline">
                <Text fontFamily="display" fontWeight="650" fontSize="18px" color="fg">
                  {t.name}
                </Text>
                {t.featured && (
                  <Text textStyle="eyebrow" color="accent.fg">
                    Most popular
                  </Text>
                )}
              </Flex>
              <HStack align="baseline" gap="1">
                <Text textStyle="data" fontSize="40px" fontWeight="600" color="fg">
                  ${t.price}
                </Text>
                <Text fontSize="13px" color="fg.subtle">
                  /mo
                </Text>
              </HStack>
              <Text fontSize="13.5px" color="fg.muted">
                {t.blurb}
              </Text>
              <Stack gap="2.5" pt="1">
                {t.points.map((p) => (
                  <HStack key={p} gap="2.5" align="flex-start">
                    <Box mt="7px" boxSize="5px" bg={t.featured ? "accent.solid" : "border.emphasized"} borderRadius="full" flexShrink={0} />
                    <Text fontSize="13px" color="fg.muted" lineHeight="1.55">
                      {p}
                    </Text>
                  </HStack>
                ))}
              </Stack>
              <Box pt="2">
                {t.featured ? (
                  <Button size="sm" w="full" asChild>
                    <Link href="/sign-up">Start with {t.name}</Link>
                  </Button>
                ) : (
                  <Button variant="outline" size="sm" w="full" asChild>
                    <Link href="/sign-up">{t.price === 0 ? "Start free" : `Choose ${t.name}`}</Link>
                  </Button>
                )}
              </Box>
            </Stack>
          ))}
        </Grid>
      </Box>
    </Box>
  );
}

/* ------------------------------- closing CTA ------------------------------ */

function ClosingCta() {
  return (
    <Box bg="bg.inverted" color="fg.inverted" position="relative" overflow="hidden">
      <Box maxW="1240px" mx="auto" px={{ base: "5", md: "10" }} py={{ base: "24", md: "36" }} position="relative">
        <Stack gap="8" align="flex-start" data-reveal>
          <HStack gap="4">
            <Box h="1.5px" w="9" bg="fg.inverted" />
            <Text textStyle="eyebrow" color="whiteAlpha.600">
              Free plan · no card required
            </Text>
          </HStack>
          <Text
            fontFamily="display"
            fontWeight="700"
            letterSpacing="-0.035em"
            lineHeight="1.04"
            fontSize={{ base: "38px", md: "64px" }}
            maxW="16ch"
          >
            Press record on your next hundred posts.
          </Text>
          <Button size="lg" px="8" asChild>
            <Link href="/sign-up">Start for free</Link>
          </Button>
        </Stack>

        {/* watermark */}
        <Text
          aria-hidden
          position="absolute"
          bottom="-6%"
          left="0"
          right="0"
          textAlign="center"
          fontFamily="display"
          fontWeight="650"
          letterSpacing="-0.04em"
          lineHeight="0.78"
          fontSize={{ base: "24vw", lg: "17rem" }}
          color="fg.inverted"
          opacity="0.05"
          userSelect="none"
          pointerEvents="none"
          whiteSpace="nowrap"
        >
          narriflow
        </Text>
      </Box>

      <Flex
        borderTopWidth="1px"
        borderColor="whiteAlpha.200"
        maxW="1240px"
        mx="auto"
        px={{ base: "5", md: "10" }}
        py="5"
        justify="space-between"
        flexWrap="wrap"
        gap="3"
      >
        <Text textStyle="eyebrow" color="whiteAlpha.500">
          © {new Date().getFullYear()} Narriflow
        </Text>
        <HStack gap="6">
          <Link href="/privacy">
            <Text fontSize="12px" color="whiteAlpha.600" _hover={{ color: "fg.inverted" }} transition="color 140ms ease">
              Privacy
            </Text>
          </Link>
          <Link href="/terms">
            <Text fontSize="12px" color="whiteAlpha.600" _hover={{ color: "fg.inverted" }} transition="color 140ms ease">
              Terms
            </Text>
          </Link>
        </HStack>
      </Flex>
    </Box>
  );
}

/* ---------------------------------- page ---------------------------------- */

export function BlueprintClient() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        gsap.set("[data-hero-word], [data-hero-sub], [data-hero-cta], [data-hero-video], [data-hero-eyebrow], [data-reveal]", {
          opacity: 1,
        });
        return;
      }

      // hero entrance
      gsap
        .timeline({ defaults: { ease: "power3.out" } })
        .fromTo("[data-hero-eyebrow]", { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.6 })
        .fromTo(
          "[data-hero-word]",
          { opacity: 0, yPercent: 110 },
          { opacity: 1, yPercent: 0, duration: 0.9, stagger: 0.055 },
          0.1,
        )
        .fromTo("[data-hero-sub]", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7 }, 0.55)
        .fromTo("[data-hero-cta]", { opacity: 0, y: 20 }, { opacity: 1, y: 0, duration: 0.7 }, 0.68)
        .fromTo("[data-hero-video]", { opacity: 0, y: 44 }, { opacity: 1, y: 0, duration: 1 }, 0.8);

      // marquee drift
      gsap.to("[data-marquee]", { xPercent: -50, duration: 34, ease: "none", repeat: -1 });

      // generic reveals
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

      // stat counters
      gsap.utils.toArray<HTMLElement>("[data-count]").forEach((el) => {
        const target = Number(el.dataset.count);
        const obj = { v: 0 };
        gsap.to(obj, {
          v: target,
          duration: 1.6,
          ease: "power2.out",
          scrollTrigger: { trigger: el, start: "top 85%" },
          onUpdate() {
            el.textContent = Math.round(obj.v).toLocaleString();
          },
        });
      });

      // hero video slight parallax
      gsap.to("[data-hero-video] video", {
        yPercent: 6,
        ease: "none",
        scrollTrigger: { trigger: "[data-hero-video]", start: "top bottom", end: "bottom top", scrub: true },
      });
    },
    { scope: rootRef },
  );

  return (
    <SmoothScroll>
      {/* Blueprint is a porcelain-light editorial design — pin light tokens
          regardless of the app color mode via Chakra's class condition. */}
      <Box ref={rootRef} className="light" bg="bg" color="fg" minH="100vh">
        <BlueprintNav />
        <Hero />
        <Marquee />
        <Pipeline />
        <StatBand />
        <Features />
        <CaptionPlayground />
        <Repurpose />
        <Pricing />
        <ClosingCta />
        <VariantDial />
      </Box>
    </SmoothScroll>
  );
}
