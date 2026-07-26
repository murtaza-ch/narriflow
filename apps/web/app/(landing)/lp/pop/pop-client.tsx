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

/* Pop palette — neo-brutalist marketing re-theme (lime highlighter + ink). */
const LIME = "#B9FF66";
const INK = "#191A23";
const GREY = "#F3F3F3";
const PAPER = "#FFFFFF";
const SHADOW = `0 5px 0 0 ${INK}`;
const SHADOW_HOVER = `0 9px 0 0 ${INK}`;

const CAPTION_WORDS = ["Stop", "editing", "shorts", "by", "hand"];

/* ------------------------------ shared atoms ------------------------------ */

function Pill({ children, bg = LIME, color = INK }: { children: React.ReactNode; bg?: string; color?: string }) {
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
      style={{ background: bg, color }}
    >
      {children}
    </Text>
  );
}

function ArrowDot({ dark = true }: { dark?: boolean }) {
  return (
    <Flex
      boxSize="40px"
      borderRadius="full"
      align="center"
      justify="center"
      flexShrink={0}
      transition="transform 220ms cubic-bezier(0.34,1.56,0.64,1)"
      _groupHover={{ transform: "rotate(45deg)" }}
      style={{ background: dark ? INK : PAPER }}
    >
      <Text fontSize="18px" style={{ color: dark ? LIME : INK }} transform="rotate(-45deg)">
        →
      </Text>
    </Flex>
  );
}

function PopButton({
  href,
  children,
  variant = "ink",
}: {
  href: string;
  children: React.ReactNode;
  variant?: "ink" | "lime" | "outline";
}) {
  const styles =
    variant === "ink"
      ? { background: INK, color: PAPER, border: `1px solid ${INK}` }
      : variant === "lime"
        ? { background: LIME, color: INK, border: `1px solid ${INK}` }
        : { background: "transparent", color: INK, border: `1px solid ${INK}` };
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
        _active={{ transform: "translateY(0)", boxShadow: "0 2px 0 0 " + INK }}
        style={styles}
      >
        {children}
      </Box>
    </Link>
  );
}

/* ---------------------------------- nav ----------------------------------- */

function PopNav() {
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
      style={{ background: "rgba(255,255,255,0.9)" }}
      backdropFilter="blur(12px)"
      borderBottom={`1px solid ${INK}1A`}
    >
      <Link href="/" aria-label="Narriflow home">
        <Logo size="md" />
      </Link>
      <HStack gap="9" display={{ base: "none", lg: "flex" }}>
        {[
          ["Features", "#features"],
          ["How it works", "#process"],
          ["Presets", "#presets"],
          ["Pricing", "#pricing"],
        ].map(([label, href]) => (
          <Link key={label} href={href ?? "#"}>
            <Text
              fontSize="15px"
              fontWeight="500"
              style={{ color: INK }}
              position="relative"
              _hover={{ _after: { transform: "scaleX(1)" } }}
              _after={{
                content: '""',
                position: "absolute",
                left: 0,
                right: 0,
                bottom: "-4px",
                height: "3px",
                background: LIME,
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
      <PopButton href="/sign-up" variant="outline">
        Start free
      </PopButton>
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
    <Box maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "120px", md: "160px" }}>
      <Grid templateColumns={{ base: "1fr", lg: "1.05fr 1fr" }} gap={{ base: "14", lg: "10" }} alignItems="center">
        {/* copy */}
        <Stack gap="8" data-pop style={{ opacity: 0 }}>
          <Text
            as="h1"
            fontFamily="display"
            fontWeight="650"
            letterSpacing="-0.02em"
            lineHeight="1.08"
            fontSize={{ base: "40px", md: "58px" }}
            style={{ color: INK }}
          >
            Turn long videos into a{" "}
            <Pill>week of posts</Pill>
          </Text>
          <Text fontSize={{ base: "16px", md: "18px" }} lineHeight="1.7" style={{ color: INK }} maxW="46ch">
            Narriflow finds your best moments, scores them for virality, burns in
            word-synced captions and publishes everywhere — from one upload.
          </Text>
          <Box>
            <PopButton href="/sign-up" variant="ink">
              Start for free
            </PopButton>
          </Box>
        </Stack>

        {/* collage */}
        <Box position="relative" minH={{ base: "340px", md: "480px" }} data-pop style={{ opacity: 0 }} aria-hidden>
          {/* lime blob */}
          <Box
            data-float="1"
            position="absolute"
            top="4%"
            right="6%"
            boxSize={{ base: "150px", md: "230px" }}
            borderRadius="full"
            style={{ background: LIME }}
          />
          {/* speech bubble: live caption card */}
          <Box
            data-float="2"
            position="absolute"
            top={{ base: "10%", md: "13%" }}
            right={{ base: "2%", md: "0%" }}
            w={{ base: "230px", md: "300px" }}
            p={{ base: "5", md: "7" }}
            borderRadius="18px"
            style={{ background: INK, boxShadow: SHADOW }}
            _after={{
              content: '""',
              position: "absolute",
              left: "34px",
              bottom: "-26px",
              width: "0",
              height: "0",
              borderLeft: "0px solid transparent",
              borderRight: "34px solid transparent",
              borderTop: `28px solid ${INK}`,
            }}
          >
            <Text fontFamily="mono" fontSize="11px" letterSpacing="0.2em" style={{ color: LIME }} mb="3">
              KARAOKE · 9:16
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
                  style={{ color: i === word ? LIME : i < word ? PAPER : "rgba(255,255,255,0.35)" }}
                >
                  {w}
                </Text>
              ))}
            </Flex>
          </Box>
          {/* score sticker */}
          <Flex
            data-float="3"
            position="absolute"
            top={{ base: "48%", md: "50%" }}
            left={{ base: "0%", md: "6%" }}
            boxSize={{ base: "92px", md: "120px" }}
            borderRadius="full"
            align="center"
            justify="center"
            flexDirection="column"
            style={{ background: INK, boxShadow: SHADOW }}
          >
            <Text fontFamily="mono" fontWeight="600" fontSize={{ base: "28px", md: "36px" }} lineHeight="1" style={{ color: LIME }} data-hero-score>
              92
            </Text>
            <Text fontFamily="mono" fontSize="9px" letterSpacing="0.22em" style={{ color: "rgba(255,255,255,0.6)" }}>
              SCORE
            </Text>
          </Flex>
          {/* plus dot */}
          <Flex
            data-float="4"
            position="absolute"
            top={{ base: "38%", md: "36%" }}
            left={{ base: "34%", md: "38%" }}
            boxSize="64px"
            borderRadius="full"
            align="center"
            justify="center"
            style={{ background: INK }}
          >
            <Text fontSize="30px" fontWeight="700" style={{ color: LIME }}>
              +
            </Text>
          </Flex>
          {/* dot grid */}
          <Box
            data-float="5"
            position="absolute"
            bottom="2%"
            left={{ base: "18%", md: "26%" }}
            w={{ base: "170px", md: "230px" }}
            h={{ base: "120px", md: "170px" }}
            style={{
              backgroundImage: `radial-gradient(${INK} 2.5px, transparent 2.5px)`,
              backgroundSize: "22px 22px",
            }}
          />
          {/* waveform chip */}
          <Flex
            data-float="6"
            position="absolute"
            bottom={{ base: "18%", md: "16%" }}
            right={{ base: "6%", md: "12%" }}
            px="5"
            py="3.5"
            gap="1.5"
            align="flex-end"
            borderRadius="14px"
            style={{ background: PAPER, border: `1px solid ${INK}`, boxShadow: SHADOW }}
          >
            {[14, 26, 18, 32, 22, 12, 28, 16].map((h, i) => (
              <Box key={i} w="5px" borderRadius="3px" style={{ height: `${h}px`, background: i === 3 ? "#2438E8" : INK }} data-wavebar />
            ))}
          </Flex>
        </Box>
      </Grid>

      {/* platform ticker */}
      <Box mt={{ base: "16", md: "24" }} overflow="hidden" py="2" aria-hidden>
        <Box display="inline-flex" whiteSpace="nowrap" data-ticker>
          {[0, 1].map((dup) => (
            <HStack key={dup} gap={{ base: "12", md: "20" }} pr={{ base: "12", md: "20" }} flexShrink={0}>
              {[...PLATFORMS, "Podcasts", "Webinars"].map((p) => (
                <Text
                  key={`${dup}-${p}`}
                  fontFamily="display"
                  fontWeight="650"
                  fontSize={{ base: "20px", md: "26px" }}
                  letterSpacing="-0.01em"
                  style={{ color: INK, opacity: 0.85 }}
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

function PopHeading({ id, pill, blurb }: { id?: string; pill: string; blurb: string }) {
  return (
    <Flex
      id={id}
      data-pop
      style={{ opacity: 0 }}
      align={{ base: "flex-start", md: "center" }}
      direction={{ base: "column", md: "row" }}
      gap={{ base: "4", md: "10" }}
      css={id ? { scrollMarginTop: "80px" } : undefined}
    >
      <Text fontFamily="display" fontWeight="650" fontSize={{ base: "30px", md: "40px" }} letterSpacing="-0.01em" flexShrink={0}>
        <Pill>{pill}</Pill>
      </Text>
      <Text fontSize="15px" lineHeight="1.65" maxW="46ch" style={{ color: INK }}>
        {blurb}
      </Text>
    </Flex>
  );
}

/* --------------------------------- services -------------------------------- */

type Service = {
  a: string;
  b: string;
  scheme: "grey" | "lime" | "ink";
  vignette: "waveform" | "captions" | "ratios" | "reframe" | "suite" | "publish";
};

const SERVICES: Service[] = [
  { a: "Moment", b: "detection", scheme: "grey", vignette: "waveform" },
  { a: "Word-synced", b: "captions", scheme: "lime", vignette: "captions" },
  { a: "Every aspect", b: "ratio", scheme: "ink", vignette: "ratios" },
  { a: "Auto-reframe", b: "+ B-roll", scheme: "grey", vignette: "reframe" },
  { a: "Content", b: "repurposing", scheme: "lime", vignette: "suite" },
  { a: "Direct", b: "publishing", scheme: "ink", vignette: "publish" },
];

function ServiceVignette({ kind, scheme }: { kind: Service["vignette"]; scheme: Service["scheme"] }) {
  const ink = scheme === "ink" ? PAPER : INK;
  const accent = scheme === "lime" ? INK : LIME;
  if (kind === "waveform") {
    return (
      <Flex gap="1.5" align="flex-end" h="64px" aria-hidden>
        {[18, 34, 24, 48, 30, 56, 40, 22, 44, 28, 14, 36].map((h, i) => (
          <Box
            key={i}
            w="7px"
            borderRadius="4px"
            data-service-bar
            style={{ height: `${h}px`, background: i === 5 ? "#2438E8" : ink, opacity: i === 5 ? 1 : 0.75 }}
          />
        ))}
      </Flex>
    );
  }
  if (kind === "captions") {
    return (
      <Stack gap="2" aria-hidden>
        <Box h="12px" w="120px" borderRadius="6px" style={{ background: ink, opacity: 0.85 }} />
        <HStack gap="2">
          <Box h="12px" w="52px" borderRadius="6px" style={{ background: accent }} />
          <Box h="12px" w="76px" borderRadius="6px" style={{ background: ink, opacity: 0.4 }} />
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
          <Box key={i} borderRadius="6px" style={{ width: `${f.w}px`, height: `${f.h}px`, border: `2px solid ${ink}`, background: i === 0 ? accent : "transparent" }} />
        ))}
      </HStack>
    );
  }
  if (kind === "reframe") {
    return (
      <Box position="relative" w="110px" h="64px" borderRadius="8px" aria-hidden style={{ border: `2px solid ${ink}`, opacity: 0.9 }}>
        <Box position="absolute" top="8px" bottom="8px" left="30px" w="34px" borderRadius="6px" style={{ border: `2px dashed ${scheme === "lime" ? "#2438E8" : LIME}` }} />
        <Box position="absolute" top="20px" left="40px" boxSize="14px" borderRadius="full" style={{ background: ink }} />
      </Box>
    );
  }
  if (kind === "suite") {
    return (
      <Stack gap="2" aria-hidden>
        {["Blog", "Thread", "Notes"].map((t) => (
          <HStack key={t} gap="2">
            <Box boxSize="7px" borderRadius="full" style={{ background: accent }} />
            <Text fontFamily="mono" fontSize="11px" letterSpacing="0.14em" style={{ color: ink }}>
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
        <Text key={p} fontFamily="mono" fontSize="10.5px" px="2.5" py="1" borderRadius="full" style={{ border: `1.5px solid ${ink}`, color: ink }}>
          {p}
        </Text>
      ))}
    </HStack>
  );
}

function Services() {
  return (
    <Box id="features" maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <PopHeading
        pill="What it does"
        blurb="One upload runs the whole pipeline. Every card below is a real stage of the machine — no add-ons, no credit math."
      />
      <Grid mt={{ base: "8", md: "12" }} templateColumns={{ base: "1fr", md: "repeat(2, 1fr)" }} gap={{ base: "6", md: "8" }}>
        {SERVICES.map((s) => {
          const bg = s.scheme === "grey" ? GREY : s.scheme === "lime" ? LIME : INK;
          const pillBg = s.scheme === "ink" ? LIME : s.scheme === "lime" ? PAPER : LIME;
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
              css={{ background: bg, border: `1px solid ${INK}`, boxShadow: SHADOW }}
            >
              <Flex justify="space-between" gap="8" align="flex-start">
                <Stack gap="1" fontSize={{ base: "22px", md: "26px" }}>
                  <Box>
                    <Pill bg={pillBg}>{s.a}</Pill>
                  </Box>
                  <Box>
                    <Pill bg={pillBg}>{s.b}</Pill>
                  </Box>
                </Stack>
                <ServiceVignette kind={s.vignette} scheme={s.scheme} />
              </Flex>
              <Flex mt={{ base: "10", md: "14" }} align="center" gap="4">
                <ArrowDot dark={s.scheme !== "ink"} />
                <Text fontSize="15px" fontWeight="500" style={{ color: s.scheme === "ink" ? PAPER : INK }}>
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
        css={{ background: GREY, border: `1px solid ${INK}`, boxShadow: SHADOW }}
      >
        <Stack gap="6">
          <Text fontFamily="display" fontWeight="650" fontSize={{ base: "26px", md: "34px" }} letterSpacing="-0.01em" style={{ color: INK }}>
            Watch the machine work
          </Text>
          <Text fontSize="15.5px" lineHeight="1.7" style={{ color: INK }} maxW="44ch">
            A 47-minute podcast goes in. Six scored clips, word-synced captions in
            every ratio, a blog post and an X thread come out — in about nine
            minutes of compute and five of your time.
          </Text>
          <Box>
            <PopButton href="/sign-up" variant="ink">
              Run your first upload free
            </PopButton>
          </Box>
        </Stack>
        <Box borderRadius="24px" overflow="hidden" css={{ border: `1px solid ${INK}`, boxShadow: SHADOW }}>
          <Video src="/videos/moment-detect.mp4" autoPlay muted loop playsInline preload="metadata" w="full" display="block" />
        </Box>
      </Grid>
    </Box>
  );
}

/* -------------------------------- process ---------------------------------- */

const PROCESS = [
  { n: "01", title: "Upload anything", body: "Drop a file, paste a YouTube link, or point the RSS autopilot at your podcast feed — new episodes queue themselves." },
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
      <PopHeading pill="How it works" blurb="Three minutes of clicking for you. Six stages of work for the machine." />
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
              transition="background 260ms ease, transform 240ms cubic-bezier(0.34,1.56,0.64,1)"
              _hover={{ transform: isOpen ? "none" : "translateY(-3px)" }}
              css={{ background: isOpen ? LIME : GREY, border: `1px solid ${INK}`, boxShadow: SHADOW }}
              aria-expanded={isOpen}
            >
              <Flex align="center" justify="space-between" gap="6">
                <HStack gap={{ base: "4", md: "7" }} align="baseline">
                  <Text fontFamily="display" fontWeight="650" fontSize={{ base: "34px", md: "56px" }} letterSpacing="-0.03em" style={{ color: INK }}>
                    {step.n}
                  </Text>
                  <Text fontFamily="display" fontWeight="650" fontSize={{ base: "18px", md: "28px" }} letterSpacing="-0.01em" style={{ color: INK }}>
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
                  css={{ background: PAPER, border: `1px solid ${INK}` }}
                  aria-hidden
                >
                  <Text fontSize={{ base: "20px", md: "26px" }} fontWeight="600" style={{ color: INK }}>
                    +
                  </Text>
                </Flex>
              </Flex>
              <Box display="grid" gridTemplateRows={isOpen ? "1fr" : "0fr"} transition="grid-template-rows 380ms cubic-bezier(0.22,1,0.36,1)">
                <Box overflow="hidden">
                  <Box mt={{ base: "4", md: "6" }} pt={{ base: "4", md: "6" }} style={{ borderTop: `1px solid ${INK}` }}>
                    <Text fontSize={{ base: "14.5px", md: "16px" }} lineHeight="1.7" style={{ color: INK }} maxW="70ch">
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

/* --------------------------------- presets --------------------------------- */

function Presets() {
  const featured = CAPTION_PRESETS.slice(0, 6);
  return (
    <Box id="presets" maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <PopHeading pill="The presets" blurb="Twelve caption styles, word-synced to the waveform. The preview is the export — meet the starting six." />
      <Grid mt={{ base: "8", md: "12" }} templateColumns={{ base: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(3, 1fr)" }} gap={{ base: "6", md: "8" }}>
        {featured.map((p) => (
          <Box
            key={p.name}
            data-pop
            style={{ opacity: 0 }}
            role="group"
            p={{ base: "7", md: "8" }}
            borderRadius="28px"
            transition="transform 240ms cubic-bezier(0.34,1.56,0.64,1), box-shadow 240ms cubic-bezier(0.34,1.56,0.64,1)"
            _hover={{ transform: "translateY(-5px)", boxShadow: SHADOW_HOVER }}
            css={{ background: PAPER, border: `1px solid ${INK}`, boxShadow: SHADOW }}
          >
            <Flex align="center" gap="4">
              <Flex boxSize="56px" borderRadius="full" align="center" justify="center" css={{ border: `1px solid ${INK}` }} style={{ background: `${p.accent}` }}>
                <Text fontFamily="display" fontWeight="800" fontSize="20px" style={{ color: INK }}>
                  Aa
                </Text>
              </Flex>
              <Stack gap="0.5">
                <Text fontFamily="display" fontWeight="650" fontSize="19px" style={{ color: INK }}>
                  {p.name}
                </Text>
                <Text fontFamily="mono" fontSize="11px" letterSpacing="0.12em" style={{ color: INK, opacity: 0.55 }}>
                  {p.accent.toUpperCase()}
                </Text>
              </Stack>
              <Box ml="auto">
                <ArrowDot />
              </Box>
            </Flex>
            <Box mt="6" pt="5" style={{ borderTop: `1px solid ${INK}` }}>
              <Text
                fontFamily="display"
                fontWeight="800"
                textTransform="uppercase"
                fontSize="20px"
                letterSpacing="-0.01em"
                style={{ color: INK }}
              >
                Word{" "}
                <Text as="span" px="1.5" borderRadius="6px" style={{ background: p.accent }}>
                  synced
                </Text>{" "}
                captions
              </Text>
            </Box>
          </Box>
        ))}
      </Grid>
      <Text mt="6" fontFamily="mono" fontSize="12px" letterSpacing="0.1em" style={{ color: INK, opacity: 0.6 }} data-pop>
        + NEON DREAMS · PASTEL CLOUD · FROSTED GLASS · SUNSET · MATRIX · STREET — AND EMOJI CAPTIONS 🔥
      </Text>
    </Box>
  );
}

/* --------------------------------- pricing --------------------------------- */

function Pricing() {
  return (
    <Box id="pricing" maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }}>
      <PopHeading pill="Pricing" blurb="A minute of source media is one processing minute. That's the whole pricing model." />
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
              css={{ background: featured ? LIME : GREY, border: `1px solid ${INK}`, boxShadow: SHADOW }}
            >
              <Flex justify="space-between" align="center">
                <Text fontFamily="display" fontWeight="650" fontSize="20px" style={{ color: INK }}>
                  {t.name}
                </Text>
                {featured && (
                  <Text fontFamily="mono" fontSize="10px" letterSpacing="0.14em" px="2.5" py="1" borderRadius="full" style={{ background: INK, color: LIME }}>
                    POPULAR
                  </Text>
                )}
              </Flex>
              <HStack align="baseline" gap="1">
                <Text fontFamily="display" fontWeight="650" fontSize="44px" letterSpacing="-0.03em" style={{ color: INK }}>
                  ${t.price}
                </Text>
                <Text fontSize="14px" style={{ color: INK, opacity: 0.6 }}>
                  /mo
                </Text>
              </HStack>
              <Stack gap="2.5" flex="1">
                {t.points.map((p) => (
                  <HStack key={p} gap="2.5" align="flex-start">
                    <Text fontSize="13px" fontWeight="700" style={{ color: INK }} aria-hidden>
                      ✓
                    </Text>
                    <Text fontSize="13.5px" lineHeight="1.55" style={{ color: INK }}>
                      {p}
                    </Text>
                  </HStack>
                ))}
              </Stack>
              <PopButton href="/sign-up" variant={featured ? "ink" : "outline"}>
                {t.price === 0 ? "Start free" : `Choose ${t.name}`}
              </PopButton>
            </Stack>
          );
        })}
      </Grid>
    </Box>
  );
}

/* --------------------------------- footer ---------------------------------- */

function PopFooter() {
  return (
    <Box maxW="1280px" mx="auto" px={{ base: "5", md: "12" }} pt={{ base: "20", md: "32" }} pb={{ base: "8", md: "12" }}>
      <Box
        data-pop
        style={{ opacity: 0 }}
        borderRadius="40px 40px 0 0"
        px={{ base: "8", md: "14" }}
        py={{ base: "10", md: "14" }}
        css={{ background: INK }}
      >
        <Flex direction={{ base: "column", md: "row" }} justify="space-between" align={{ base: "flex-start", md: "center" }} gap="8">
          <Stack gap="4">
            <Text fontFamily="display" fontWeight="650" fontSize={{ base: "26px", md: "34px" }} letterSpacing="-0.01em" style={{ color: PAPER }}>
              Press record on your next{" "}
              <Pill>hundred posts</Pill>
            </Text>
            <Text fontSize="14.5px" style={{ color: "rgba(255,255,255,0.65)" }}>
              Free plan · 60 processing minutes a month · no card required
            </Text>
          </Stack>
          <PopButton href="/sign-up" variant="lime">
            Start for free
          </PopButton>
        </Flex>
        <Flex mt={{ base: "10", md: "14" }} pt="6" justify="space-between" flexWrap="wrap" gap="4" style={{ borderTop: "1px solid rgba(255,255,255,0.18)" }}>
          <Text fontFamily="mono" fontSize="11px" letterSpacing="0.14em" style={{ color: "rgba(255,255,255,0.5)" }}>
            © {new Date().getFullYear()} NARRIFLOW
          </Text>
          <HStack gap="6">
            <Link href="/privacy">
              <Text fontSize="12.5px" style={{ color: "rgba(255,255,255,0.65)" }} _hover={{ color: PAPER }} transition="color 140ms ease">
                Privacy
              </Text>
            </Link>
            <Link href="/terms">
              <Text fontSize="12.5px" style={{ color: "rgba(255,255,255,0.65)" }} _hover={{ color: PAPER }} transition="color 140ms ease">
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

export function PopClient() {
  const rootRef = useRef<HTMLDivElement>(null);

  useGSAP(
    () => {
      const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      if (reduced) {
        gsap.set("[data-pop]", { opacity: 1 });
        return;
      }

      // pop-in reveals: slight rotation + back-out settle
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

      // hero collage floats — each element bobs at its own pace
      gsap.utils.toArray<HTMLElement>("[data-float]").forEach((el, i) => {
        gsap.to(el, {
          y: i % 2 ? 12 : -12,
          duration: 2.4 + i * 0.35,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
        });
      });

      // platform ticker
      gsap.to("[data-ticker]", { xPercent: -50, duration: 24, ease: "none", repeat: -1 });

      // waveform chips dance
      gsap.utils.toArray<HTMLElement>("[data-wavebar]").forEach((bar, i) => {
        gsap.to(bar, {
          scaleY: 0.5 + ((i * 37) % 10) / 12,
          transformOrigin: "bottom",
          duration: 0.5 + ((i * 13) % 5) / 10,
          ease: "sine.inOut",
          yoyo: true,
          repeat: -1,
        });
      });
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

      // hero score ticks between values
      const scoreEl = document.querySelector("[data-hero-score]");
      if (scoreEl) {
        const values = [92, 87, 74, 92];
        let idx = 0;
        gsap.timeline({ repeat: -1, repeatDelay: 1.6 }).call(() => {
          idx = (idx + 1) % values.length;
          scoreEl.textContent = String(values[idx]);
        });
      }
    },
    { scope: rootRef },
  );

  return (
    <SmoothScroll>
      {/* Pop is a fixed light neo-brutalist composition — pin light tokens */}
      <Box ref={rootRef} className="light" minH="100vh" overflowX="clip" style={{ background: PAPER, color: INK }}>
        <PopNav />
        <Hero />
        <Services />
        <Banner />
        <Process />
        <Presets />
        <Pricing />
        <PopFooter />
        <VariantDial />
      </Box>
    </SmoothScroll>
  );
}
