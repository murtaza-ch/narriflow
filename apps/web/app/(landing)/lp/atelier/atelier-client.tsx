"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Box, Flex, Grid, HStack, Stack, Text, chakra } from "@chakra-ui/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { useGSAP } from "@gsap/react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { SmoothScroll } from "../../_components/smooth-scroll";
import { VariantDial } from "../../_components/variant-dial";
import { CAPTION_PRESETS, REPURPOSE_FORMATS, TIERS } from "../../_components/landing-data";

if (typeof window !== "undefined") {
  gsap.registerPlugin(ScrollTrigger, useGSAP);
}

const Video = chakra("video");

const STATEMENT =
  "Your best moments are already recorded. Narriflow finds them, scores them, and ships them — while you make the next one.";

const MOMENT_ROWS = [
  { tc: "00:12:41", score: 92 },
  { tc: "00:31:05", score: 87 },
  { tc: "00:44:56", score: 74 },
];

const STATS = [
  { value: "5", unit: "min", label: "of your time per episode" },
  { value: "4", unit: "", label: "aspect ratios per render" },
  { value: "12", unit: "", label: "caption presets" },
  { value: "5", unit: "", label: "platforms, one publish" },
];

/* ---------------------------------- nav ---------------------------------- */

function AtelierNav() {
  return (
    <Flex
      as="header"
      position="fixed"
      top="0"
      insetX="0"
      zIndex="60"
      h="64px"
      px={{ base: "6", md: "12" }}
      align="center"
      justify="space-between"
      bg="bg/75"
      backdropFilter="blur(18px) saturate(1.4)"
      borderBottomWidth="1px"
      borderColor="border.subtle"
    >
      <Link href="/" aria-label="Narriflow home">
        <Logo size="md" />
      </Link>
      <HStack gap="8">
        <Link href="#pricing">
          <Text fontSize="13px" fontWeight="500" color="fg.muted" _hover={{ color: "fg" }} transition="color 160ms ease">
            Pricing
          </Text>
        </Link>
        <Link href="/sign-in">
          <Text fontSize="13px" fontWeight="500" color="fg.muted" _hover={{ color: "fg" }} transition="color 160ms ease" display={{ base: "none", md: "block" }}>
            Sign in
          </Text>
        </Link>
        <Button variant="outline" size="sm" px="5" asChild>
          <Link href="/sign-up">Start free</Link>
        </Button>
      </HStack>
    </Flex>
  );
}

/* ---------------------------------- hero --------------------------------- */

function Hero() {
  return (
    <Box pt={{ base: "160px", md: "220px" }} px={{ base: "6", md: "12" }}>
      <Stack align="center" gap={{ base: "6", md: "8" }} textAlign="center">
        <Text data-lux textStyle="data" fontSize="12px" letterSpacing="0.22em" color="fg.subtle" style={{ opacity: 0 }}>
          AI CLIPPING · CAPTIONS · PUBLISHING
        </Text>
        <Text
          data-lux
          as="h1"
          fontFamily="display"
          fontWeight="650"
          letterSpacing="-0.04em"
          lineHeight="1.02"
          fontSize={{ base: "44px", md: "76px", lg: "92px" }}
          color="fg"
          maxW="14ch"
          style={{ opacity: 0 }}
        >
          A week of posts.
          <br />
          From one recording.
        </Text>
        <Text data-lux fontSize={{ base: "16px", md: "19px" }} color="fg.muted" maxW="46ch" lineHeight="1.65" style={{ opacity: 0 }}>
          Find, score, and caption moments worth posting.
        </Text>
        <HStack data-lux gap="5" pt="2" style={{ opacity: 0 }}>
          <Button size="lg" px="8" asChild>
            <Link href="/sign-up">Start for free</Link>
          </Button>
          <Link href="#work">
            <Text fontSize="15px" fontWeight="500" color="fg.muted" _hover={{ color: "fg" }} transition="color 160ms ease">
              See how it works&ensp;↓
            </Text>
          </Link>
        </HStack>
      </Stack>

      {/* product shot */}
      <Box id="work" maxW="1180px" mx="auto" mt={{ base: "16", md: "28" }} data-hero-shot style={{ opacity: 0 }}>
        <Box
          borderRadius={{ base: "18px", md: "28px" }}
          overflow="hidden"
          boxShadow="0 2px 8px rgba(14,16,19,0.04), 0 40px 110px rgba(14,16,19,0.18)"
          data-hero-video
        >
          <Video src="/videos/moment-detect.mp4" autoPlay muted loop playsInline preload="metadata" w="full" display="block" />
        </Box>
      </Box>
    </Box>
  );
}

/* ------------------------------- statement -------------------------------- */

function Statement() {
  return (
    <Box maxW="920px" mx="auto" px={{ base: "6", md: "12" }} py={{ base: "32", md: "56" }}>
      <Text
        as="p"
        data-statement
        fontFamily="display"
        fontWeight="600"
        letterSpacing="-0.025em"
        lineHeight="1.28"
        fontSize={{ base: "28px", md: "44px" }}
        textAlign="center"
      >
        {STATEMENT.split(" ").map((word, i) => (
          <Text as="span" key={i} data-statement-word color="fg" display="inline">
            {word}{" "}
          </Text>
        ))}
      </Text>
    </Box>
  );
}

/* --------------------------------- score ---------------------------------- */

function Score() {
  return (
    <Box maxW="880px" mx="auto" px={{ base: "6", md: "12" }} pb={{ base: "32", md: "56" }} textAlign="center">
      <Text
        data-score-number
        textStyle="data"
        fontWeight="400"
        fontSize={{ base: "140px", md: "260px" }}
        lineHeight="1"
        color="fg"
        letterSpacing="-0.06em"
      >
        0
      </Text>
      <Text data-lux mt="2" fontSize={{ base: "15px", md: "17px" }} color="fg.muted" style={{ opacity: 0 }}>
        Every moment scored for virality — you only render the winners.
      </Text>

      <Stack mt={{ base: "12", md: "16" }} gap="0" maxW="520px" mx="auto">
        {MOMENT_ROWS.map((row, i) => (
          <Flex
            key={row.tc}
            data-lux
            style={{ opacity: 0 }}
            justify="space-between"
            align="baseline"
            py="4"
            borderTopWidth="1px"
            borderColor="border.subtle"
            _last={{ borderBottomWidth: "1px" }}
          >
            <Text textStyle="data" fontSize="14px" color="fg.timecode">
              {row.tc}
            </Text>
            <Box flex="1" mx="6" h="1px" bg="border.subtle" />
            <Text textStyle="data" fontSize="14px" color={i === 0 ? "fg" : "fg.subtle"} fontWeight={i === 0 ? "600" : "400"}>
              {row.score}
              {i === 0 && (
                <Text as="span" color="accent.fg">
                  {" "}
                  · rendered
                </Text>
              )}
            </Text>
          </Flex>
        ))}
      </Stack>
    </Box>
  );
}

/* ------------------------------ captions (ink) ----------------------------- */

function Captions() {
  const [active, setActive] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(() => setActive((a) => (a + 1) % CAPTION_PRESETS.length), 1600);
    return () => window.clearInterval(id);
  }, []);

  return (
    <Box bg="bg.inverted" color="fg.inverted" py={{ base: "24", md: "40" }}>
      <Stack align="center" gap={{ base: "10", md: "14" }} px={{ base: "6", md: "12" }} textAlign="center">
        <Stack gap="4" data-lux style={{ opacity: 0 }}>
          <Text textStyle="data" fontSize="12px" letterSpacing="0.22em" color="whiteAlpha.500">
            CAPTION STUDIO
          </Text>
          <Text
            fontFamily="display"
            fontWeight="650"
            letterSpacing="-0.03em"
            fontSize={{ base: "32px", md: "52px" }}
            lineHeight="1.08"
          >
            Word for word.
            <br />
            The preview is the export.
          </Text>
        </Stack>

        <Box data-lux w={{ base: "240px", md: "300px" }} style={{ opacity: 0 }}>
          <Box
            borderRadius="36px"
            overflow="hidden"
            boxShadow="0 40px 120px rgba(0,0,0,0.55)"
            border="1px solid rgba(251,251,252,0.14)"
          >
            <Video src="/videos/caption-loop.mp4" autoPlay muted loop playsInline preload="metadata" w="full" display="block" />
          </Box>
        </Box>

        {/* preset line — the active one lights up; click to hold */}
        <Flex data-lux gap={{ base: "3", md: "5" }} flexWrap="wrap" justify="center" maxW="720px" style={{ opacity: 0 }}>
          {CAPTION_PRESETS.map((p, i) => (
            <Text
              key={p.name}
              as="button"
              onClick={() => setActive(i)}
              textStyle="data"
              fontSize="12.5px"
              letterSpacing="0.1em"
              cursor="pointer"
              transition="color 300ms ease"
              style={{ color: i === active ? p.accent : "rgba(251,251,252,0.38)" }}
            >
              {p.name.toUpperCase()}
            </Text>
          ))}
        </Flex>
      </Stack>
    </Box>
  );
}

/* -------------------------------- repurpose -------------------------------- */

function Repurpose() {
  return (
    <Box maxW="1180px" mx="auto" px={{ base: "6", md: "12" }} py={{ base: "24", md: "44" }}>
      <Grid templateColumns={{ base: "1fr", lg: "1fr 460px" }} gap={{ base: "12", lg: "24" }} alignItems="center">
        <Stack gap={{ base: "8", md: "10" }} order={{ base: 2, lg: 1 }}>
          <Stack gap="4" data-lux style={{ opacity: 0 }}>
            <Text textStyle="data" fontSize="12px" letterSpacing="0.22em" color="fg.subtle">
              CONTENT SUITE
            </Text>
            <Text fontFamily="display" fontWeight="650" letterSpacing="-0.03em" fontSize={{ base: "32px", md: "52px" }} lineHeight="1.06" color="fg">
              It writes, too.
            </Text>
            <Text fontSize={{ base: "15px", md: "17px" }} color="fg.muted" lineHeight="1.7" maxW="44ch">
              Draft posts and show notes from your transcript.
            </Text>
          </Stack>
          <Stack gap="0">
            {REPURPOSE_FORMATS.map((f) => (
              <Flex
                key={f.name}
                data-lux
                style={{ opacity: 0 }}
                justify="space-between"
                align="baseline"
                py="4"
                borderTopWidth="1px"
                borderColor="border.subtle"
                _last={{ borderBottomWidth: "1px" }}
                role="group"
              >
                <Text fontFamily="display" fontWeight="600" fontSize={{ base: "16px", md: "18px" }} color="fg" letterSpacing="-0.01em">
                  {f.name}
                </Text>
                <Text fontSize="13px" color="fg.subtle" display={{ base: "none", sm: "block" }}>
                  {f.detail}
                </Text>
              </Flex>
            ))}
          </Stack>
        </Stack>
        <Box data-lux order={{ base: 1, lg: 2 }} style={{ opacity: 0 }}>
          <Box borderRadius="24px" overflow="hidden" boxShadow="0 2px 8px rgba(14,16,19,0.04), 0 30px 90px rgba(14,16,19,0.16)">
            <Video src="/videos/repurpose-burst.mp4" autoPlay muted loop playsInline preload="metadata" w="full" display="block" />
          </Box>
        </Box>
      </Grid>
    </Box>
  );
}

/* ---------------------------------- stats --------------------------------- */

function StatRow() {
  return (
    <Box maxW="1180px" mx="auto" px={{ base: "6", md: "12" }} pb={{ base: "24", md: "44" }}>
      <Grid templateColumns={{ base: "repeat(2, 1fr)", md: "repeat(4, 1fr)" }} borderTopWidth="1px" borderColor="border.subtle">
        {STATS.map((s, i) => (
          <Stack
            key={s.label}
            data-lux
            style={{ opacity: 0 }}
            py={{ base: "8", md: "12" }}
            px={{ base: "3", md: "8" }}
            gap="2"
            borderLeftWidth={{ base: i % 2 === 1 ? "1px" : "0", md: i > 0 ? "1px" : "0" }}
            borderColor="border.subtle"
          >
            <HStack align="baseline" gap="1">
              <Text textStyle="data" fontWeight="400" fontSize={{ base: "40px", md: "56px" }} color="fg" letterSpacing="-0.04em">
                {s.value}
              </Text>
              {s.unit && (
                <Text textStyle="data" fontSize="16px" color="fg.subtle">
                  {s.unit}
                </Text>
              )}
            </HStack>
            <Text fontSize="12.5px" color="fg.muted" lineHeight="1.5">
              {s.label}
            </Text>
          </Stack>
        ))}
      </Grid>
    </Box>
  );
}

/* --------------------------------- pricing -------------------------------- */

function Pricing() {
  return (
    <Box id="pricing" maxW="1180px" mx="auto" px={{ base: "6", md: "12" }} py={{ base: "16", md: "24" }} css={{ scrollMarginTop: "64px" }}>
      <Stack align="center" textAlign="center" gap="4" data-lux style={{ opacity: 0 }}>
        <Text textStyle="data" fontSize="12px" letterSpacing="0.22em" color="fg.subtle">
          PRICING
        </Text>
        <Text fontFamily="display" fontWeight="650" letterSpacing="-0.03em" fontSize={{ base: "32px", md: "52px" }} color="fg">
          A minute in is a minute metered.
        </Text>
        <Text fontSize="15px" color="fg.muted" maxW="44ch" lineHeight="1.65">
          One source minute equals one processing minute.
        </Text>
      </Stack>

      <Grid
        mt={{ base: "12", md: "20" }}
        templateColumns={{ base: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" }}
        borderTopWidth="1px"
        borderColor="border.subtle"
      >
        {TIERS.map((t, i) => (
          <Stack
            key={t.name}
            data-lux
            style={{ opacity: 0 }}
            py={{ base: "10", md: "14" }}
            px={{ base: "2", md: "8" }}
            gap="6"
            borderLeftWidth={{ base: "0", lg: i > 0 ? "1px" : "0" }}
            borderColor="border.subtle"
          >
            <HStack gap="2.5">
              <Text fontFamily="display" fontWeight="600" fontSize="17px" color="fg" letterSpacing="-0.01em">
                {t.name}
              </Text>
              {t.featured && <Box boxSize="6px" borderRadius="full" bg="accent.solid" mt="1px" />}
            </HStack>
            <HStack align="baseline" gap="1.5">
              <Text textStyle="data" fontWeight="400" fontSize={{ base: "44px", md: "52px" }} color="fg" letterSpacing="-0.04em">
                ${t.price}
              </Text>
              <Text fontSize="13px" color="fg.subtle">
                /mo
              </Text>
            </HStack>
            <Stack gap="2.5" flex="1">
              {t.points.map((p) => (
                <Text key={p} fontSize="13px" color="fg.muted" lineHeight="1.55">
                  {p}
                </Text>
              ))}
            </Stack>
            {t.featured ? (
              <Button size="sm" asChild>
                <Link href="/sign-up">Choose {t.name}</Link>
              </Button>
            ) : (
              <Link href="/sign-up">
                <Text fontSize="14px" fontWeight="500" color="fg.muted" _hover={{ color: "fg" }} transition="color 160ms ease">
                  Choose {t.name} →
                </Text>
              </Link>
            )}
          </Stack>
        ))}
      </Grid>
    </Box>
  );
}

/* ----------------------------------- cta ---------------------------------- */

function ClosingCta() {
  return (
    <Box textAlign="center" py={{ base: "28", md: "48" }} px="6">
      <Stack align="center" gap={{ base: "6", md: "8" }} data-lux style={{ opacity: 0 }}>
        <Text
          fontFamily="display"
          fontWeight="650"
          letterSpacing="-0.04em"
          lineHeight="1.04"
          fontSize={{ base: "40px", md: "72px" }}
          color="fg"
        >
          Start for free.
        </Text>
        <Text fontSize="15px" color="fg.muted">
          60 processing minutes a month. No card required.
        </Text>
        <Button size="lg" px="9" asChild>
          <Link href="/sign-up">Get started</Link>
        </Button>
      </Stack>

      <Flex
        maxW="1180px"
        mx="auto"
        mt={{ base: "20", md: "32" }}
        pt="6"
        borderTopWidth="1px"
        borderColor="border.subtle"
        justify="space-between"
        align="center"
        flexWrap="wrap"
        gap="4"
      >
        <Text textStyle="data" fontSize="11px" letterSpacing="0.14em" color="fg.subtle">
          © {new Date().getFullYear()} NARRIFLOW
        </Text>
        <HStack gap="6">
          <Link href="/privacy">
            <Text fontSize="12px" color="fg.subtle" _hover={{ color: "fg" }} transition="color 160ms ease">
              Privacy
            </Text>
          </Link>
          <Link href="/terms">
            <Text fontSize="12px" color="fg.subtle" _hover={{ color: "fg" }} transition="color 160ms ease">
              Terms
            </Text>
          </Link>
        </HStack>
      </Flex>
    </Box>
  );
}

/* ----------------------------------- page --------------------------------- */

export function AtelierClient() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        gsap.set("[data-lux], [data-hero-shot]", { opacity: 1, clearProps: "filter,transform" });
        gsap.set("[data-statement-word]", { opacity: 1 });
        const scoreEl = document.querySelector("[data-score-number]");
        if (scoreEl) scoreEl.textContent = "92";
        return;
      }

      /* the single motion vocabulary: rise + de-blur */
      const lux = (el: Element, delay = 0) =>
        gsap.fromTo(
          el,
          { opacity: 0, y: 28, filter: "blur(10px)" },
          { opacity: 1, y: 0, filter: "blur(0px)", duration: 1.1, ease: "power3.out", delay },
        );

      // hero entrance
      const heroEls = gsap.utils.toArray<HTMLElement>("[data-lux]").slice(0, 4);
      heroEls.forEach((el, i) => {
        lux(el, 0.15 + i * 0.12);
      });
      gsap.fromTo(
        "[data-hero-shot]",
        { opacity: 0, y: 70, scale: 0.96 },
        { opacity: 1, y: 0, scale: 1, duration: 1.4, ease: "power3.out", delay: 0.65 },
      );

      // scroll reveals for the rest
      gsap.utils.toArray<HTMLElement>("[data-lux]").slice(4).forEach((el) => {
        gsap.fromTo(
          el,
          { opacity: 0, y: 28, filter: "blur(10px)" },
          {
            opacity: 1,
            y: 0,
            filter: "blur(0px)",
            duration: 1.1,
            ease: "power3.out",
            scrollTrigger: { trigger: el, start: "top 86%" },
          },
        );
      });

      // hero shot subtle zoom while scrolling past
      gsap.fromTo(
        "[data-hero-video]",
        { scale: 1.0 },
        {
          scale: 1.035,
          ease: "none",
          scrollTrigger: { trigger: "[data-hero-shot]", start: "top 80%", end: "bottom 10%", scrub: true },
        },
      );

      // statement: words ink in as you scroll through
      const words = gsap.utils.toArray<HTMLElement>("[data-statement-word]");
      gsap.set(words, { opacity: 0.16 });
      gsap.to(words, {
        opacity: 1,
        stagger: 0.06,
        ease: "none",
        scrollTrigger: { trigger: "[data-statement]", start: "top 76%", end: "bottom 46%", scrub: 0.4 },
      });

      // score counter
      const scoreEl = document.querySelector("[data-score-number]");
      if (scoreEl) {
        const obj = { v: 0 };
        gsap.to(obj, {
          v: 92,
          duration: 1.8,
          ease: "power2.out",
          scrollTrigger: { trigger: scoreEl, start: "top 78%" },
          onUpdate() {
            scoreEl.textContent = String(Math.round(obj.v));
          },
        });
      }
    },
    { scope: rootRef },
  );

  return (
    <SmoothScroll>
      {/* Atelier is a fixed light composition — pin light tokens in any app mode */}
      <Box ref={rootRef} className="light" bg="bg" color="fg" minH="100vh" overflowX="clip">
        <AtelierNav />
        <Hero />
        <Statement />
        <Score />
        <Captions />
        <Repurpose />
        <StatRow />
        <Pricing />
        <ClosingCta />
        <VariantDial />
      </Box>
    </SmoothScroll>
  );
}
