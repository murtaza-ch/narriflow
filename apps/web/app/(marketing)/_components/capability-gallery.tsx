"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Box, chakra, Flex, Grid, Heading, Stack, Text } from "@chakra-ui/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Captions, Gauge, RectangleHorizontal, Scissors, Share2, Wand2 } from "lucide-react";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { FEATURES, type Comp } from "@narriflow/stage";
import { useStageCanvas } from "./stage/use-stage-canvas";

/*
 * Capabilities as a horizontal world: the section pins and vertical scroll
 * slides the six product loops past. Without motion (reduced motion, or
 * before hydration) it is a plain swipeable row with scroll snapping.
 */

const Canvas = chakra("canvas");

function FeatureStage({ composition }: { composition: Comp }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  useStageCanvas(canvasRef, (ctx, width, height, seconds) => {
    ctx.scale(width / composition.width, height / composition.height);
    composition.draw(ctx, seconds % composition.duration);
  }, { stillAt: composition.duration / 2 });
  return <Canvas ref={canvasRef} position="absolute" inset="0" w="full" h="full" display="block" aria-hidden="true" />;
}

const ITEMS = [
  {
    name: "moments",
    ratio: 16 / 9,
    icon: Scissors,
    title: "AI moment detection",
    description: "Finds and scores the clip-worthy moments in your recording.",
  },
  {
    name: "captions",
    ratio: 16 / 9,
    icon: Captions,
    title: "Word-synced captions",
    description: "12 presets and emoji captions that render exactly as previewed.",
  },
  {
    name: "ratios",
    ratio: 1,
    icon: RectangleHorizontal,
    title: "Every aspect ratio",
    description: "9:16, 1:1, 16:9, and 4:5 renders from a single source clip.",
  },
  {
    name: "reframe",
    ratio: 1,
    icon: Wand2,
    title: "Auto-reframe + B-roll",
    description: "Speaker-tracking crops and stock B-roll cutaways, built in.",
  },
  {
    name: "repurpose",
    ratio: 1,
    icon: Gauge,
    title: "Content-suite repurposing",
    description: "Blog posts, X threads, LinkedIn posts, and show notes from one transcript.",
  },
  {
    name: "publish",
    ratio: 1,
    icon: Share2,
    title: "Direct publishing",
    description: "Schedule and publish straight to your connected social accounts.",
  },
];

export function CapabilityGallery() {
  const sectionRef = useRef<HTMLElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const [pinned, setPinned] = useState(false);
  const [active, setActive] = useState(0);

  // Commit the pinned layout first so ScrollTrigger measures the final track.
  useLayoutEffect(() => {
    if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) setPinned(true);
  }, []);

  useLayoutEffect(() => {
    if (!pinned) return;
    gsap.registerPlugin(ScrollTrigger);
    const ctx = gsap.context(() => {
      const track = trackRef.current;
      if (!track) return;
      const distance = () => Math.max(0, track.scrollWidth - window.innerWidth);
      gsap.to(track, {
        x: () => -distance(),
        ease: "none",
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          // scroll a little less than the track travels, so the gallery moves briskly
          end: () => `+=${distance() * 0.75}`,
          pin: true,
          scrub: 0.6,
          invalidateOnRefresh: true,
          onUpdate: (self) => {
            setActive(Math.round(self.progress * (ITEMS.length - 1)));
            if (barRef.current) barRef.current.style.transform = `scaleX(${self.progress})`;
          },
        },
      });
    }, sectionRef);
    return () => ctx.revert();
  }, [pinned]);

  return (
    <Box
      as="section"
      ref={sectionRef}
      id="features"
      position="relative"
      minH={pinned ? "100vh" : undefined}
      display="flex"
      flexDirection="column"
      justifyContent="center"
      overflow="hidden"
      py={pinned ? "0" : { base: "16", md: "24" }}
    >
      <Flex mx="auto" w="full" maxW="1200px" px="6" align="flex-end" justify="space-between" gap="6">
        <Stack gap="3" maxW="640px" layerStyle="band">
          <Text textStyle="eyebrow" color="fg.subtle">
            Capabilities
          </Text>
          <Heading as="h2" textStyle="display" fontSize={{ base: "30px", md: "42px" }} color="fg">
            The whole pipeline, one workflow.
          </Heading>
        </Stack>
        <Stack gap="2" align="flex-end" display={{ base: "none", md: "flex" }} aria-hidden="true">
          <Text textStyle="data" fontSize="13px" color="fg.muted">
            {String(active + 1).padStart(2, "0")} / {String(ITEMS.length).padStart(2, "0")}
          </Text>
          <Box w="120px" h="2px" bg="border">
            <Box ref={barRef} h="full" bg="accent.solid" transformOrigin="left" style={{ transform: "scaleX(0)" }} />
          </Box>
        </Stack>
      </Flex>

      <Box overflowX={pinned ? "visible" : "auto"} css={pinned ? undefined : { scrollSnapType: "x mandatory" }} mt="10">
        <Flex ref={trackRef} gap={{ base: "4", md: "6" }} px={{ base: "6", md: "max(24px, calc((100vw - 1200px) / 2 + 24px))" }} w="max-content">
          {ITEMS.map(({ name, ratio, icon: Icon, title, description }, i) => (
            <Grid
              key={name}
              w={{ base: "84vw", md: "72vw", lg: "62vw" }}
              maxW="880px"
              templateColumns={{ base: "1fr", lg: "minmax(0, 0.8fr) minmax(0, 1.2fr)" }}
              gap={{ base: "5", lg: "8" }}
              alignItems="center"
              p={{ base: "4", md: "6" }}
              borderWidth="1px"
              borderColor={active === i && pinned ? "border.emphasized" : "border.subtle"}
              borderRadius="l3"
              bg="bg"
              transition="border-color 300ms ease, opacity 300ms ease"
              opacity={pinned && Math.abs(active - i) > 1 ? 0.55 : 1}
              css={{ scrollSnapAlign: "center" }}
            >
              <Stack gap="4" order={{ base: 2, lg: 1 }}>
                <Flex align="center" justify="space-between">
                  <Flex color="fg.muted" aria-hidden="true">
                    <Icon size={20} strokeWidth={1.75} />
                  </Flex>
                  <Text textStyle="data" fontSize="12px" color="fg.subtle">
                    {String(i + 1).padStart(2, "0")}
                  </Text>
                </Flex>
                <Heading as="h3" textStyle="title" fontSize={{ base: "20px", md: "24px" }} color="fg">
                  {title}
                </Heading>
                <Text fontSize="14px" color="fg.muted" lineHeight="1.65" maxW="36ch">
                  {description}
                </Text>
              </Stack>
              <Flex order={{ base: 1, lg: 2 }} justify="center">
                <MediaWell ratio={ratio} w="full" maxW={ratio === 1 ? "min(100%, 46vh)" : "100%"}>
                  <FeatureStage composition={FEATURES[i]!} />
                </MediaWell>
              </Flex>
            </Grid>
          ))}
        </Flex>
      </Box>
    </Box>
  );
}
