"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { Box, chakra, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { backdrop, ease, hero, lerpRect, osc, P, ramp, type Rect, STEPS } from "@narriflow/stage";
import { scrollToY } from "@/app/_components/smooth-scroll";
import { useStageCanvas } from "./stage/use-stage-canvas";

/*
 * "How it works" as a place you scroll through: the stage card grows into a
 * full-screen studio, and scroll drives the live pipeline storyboard from
 * @narriflow/stage (the same model the marketing videos are rendered from).
 * The hosts keep breathing on their own clock while the story is scrubbed.
 */

const Canvas = chakra("canvas");

const CHAPTERS = [
  {
    title: "Scan every minute.",
    body: "Upload a recording or paste a YouTube link. Narriflow transcribes it word by word and reads the whole episode for clip-worthy moments.",
  },
  {
    title: "Surface the moments that hit.",
    body: "Every candidate gets a virality score, so the strongest minute of a 47-minute episode rises to the top.",
  },
  {
    title: "Reframed for vertical.",
    body: "Speaker-aware auto-layout follows whoever is talking and cuts a clean 9:16 from the wide shot.",
  },
  {
    title: "Captioned word by word.",
    body: "24 caption styles, timed to every word. What you preview is exactly what renders.",
  },
  {
    title: "Scheduled and shipped.",
    body: "Clips go straight to TikTok, YouTube Shorts, Reels, LinkedIn and X on the schedule you set.",
  },
];

// Timeline shares of the pinned scroll: grow in, walk the story, settle out.
const ENTER = 0.1;
const STORY = 0.8;
const PIN_SCREENS = 5;

/*
 * Narrow screens can't show the whole 16:9 studio legibly, so a camera
 * follows the action in storyboard space: source + timeline, then the
 * vertical clip, then the three shipped clips.
 */
const SHOT_WIDE: Rect = { x: 190, y: 130, w: 1540, h: 880 };
const SHOT_CLIP: Rect = { x: 640, y: 120, w: 640, h: 910 };
const SHOT_SHIP: Rect = { x: 130, y: 100, w: 1660, h: 900 };
function camera(t: number): Rect {
  const toClip = ramp(t, 4.3, 5.3, ease.inOut);
  const toShip = ramp(t, 9.9, 10.8, ease.inOut);
  return lerpRect(lerpRect(SHOT_WIDE, SHOT_CLIP, toClip), SHOT_SHIP, toShip);
}

/** Uniform 0..1 progress → story time, giving each chapter an equal share of scroll. */
function storyTime(u: number) {
  const n = STEPS.length;
  const seg = Math.min(n - 1, Math.floor(u * n));
  const step = STEPS[seg]!;
  return step.from + (step.to - step.from) * (u * n - seg);
}

export function PipelineWorld() {
  const sectionRef = useRef<HTMLElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const railRef = useRef<HTMLDivElement>(null);
  const story = useRef({ u: 0 });
  const trigger = useRef<ScrollTrigger | null>(null);
  const shown = useRef(-1);
  const [chapter, setChapter] = useState(-1);

  const { invalidate } = useStageCanvas(
    canvasRef,
    (ctx, w, h, now) => {
      const u = story.current.u;
      const t = storyTime(u);
      backdrop(ctx, w, h, osc(now, 5, 15), [0.62, 0.5], 48);
      // Wide screens keep the left third for the chapter copy and show the
      // whole studio; narrow screens follow the action with the camera.
      const wide = w >= 900;
      const area = wide
        ? { x: w * 0.3, y: h * 0.08, w: w * 0.68, h: h * 0.76 }
        : { x: w * 0.03, y: h * 0.33, w: w * 0.94, h: h * 0.54 };
      const shot = wide ? { x: 0, y: 0, w: 1920, h: 1080 } : camera(t);
      const k = Math.min(area.w / shot.w, area.h / shot.h);
      ctx.translate(area.x + (area.w - shot.w * k) / 2 - shot.x * k, area.y + (area.h - shot.h * k) / 2 - shot.y * k);
      ctx.scale(k, k);
      if (!wide) {
        ctx.beginPath();
        ctx.rect(shot.x, shot.y, shot.w, shot.h);
        ctx.clip();
      }
      hero.draw(ctx, t, { ambient: now, chrome: false, backdrop: false });

      const next = u <= 0.0005 ? -1 : Math.min(STEPS.length - 1, Math.floor(u * STEPS.length));
      if (next !== shown.current) {
        shown.current = next;
        setChapter(next);
      }
      if (railRef.current) railRef.current.style.transform = `scaleX(${u})`;
    },
    { stillAt: 3 },
  );

  useLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    gsap.registerPlugin(ScrollTrigger);
    const startScale = () => Math.min(0.86, (Math.min(window.innerWidth, 1240) - 48) / window.innerWidth);
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        defaults: { ease: "none" },
        scrollTrigger: {
          trigger: sectionRef.current,
          start: "top top",
          end: () => `+=${window.innerHeight * PIN_SCREENS}`,
          pin: true,
          scrub: 0.5,
          invalidateOnRefresh: true,
        },
      });
      tl.fromTo(
        stageRef.current,
        { scale: startScale, borderRadius: 28 },
        { scale: 1, borderRadius: 0, duration: ENTER, ease: "power2.inOut" },
        0,
      )
        .fromTo(story.current, { u: 0 }, { u: 1, duration: STORY }, ENTER)
        .to(stageRef.current, { scale: 0.9, borderRadius: 28, duration: 1 - ENTER - STORY, ease: "power2.inOut" }, ENTER + STORY);
      trigger.current = tl.scrollTrigger ?? null;
    }, sectionRef);
    return () => {
      trigger.current = null;
      ctx.revert();
    };
  }, []);

  const goTo = (index: number) => {
    const u = (index + 0.12) / STEPS.length;
    const st = trigger.current;
    if (!st) {
      // Reduced motion: step through the story in place.
      story.current.u = u;
      invalidate();
      return;
    }
    scrollToY(st.start + (ENTER + STORY * u) * (st.end - st.start));
  };

  return (
    <Box as="section" ref={sectionRef} id="pipeline" position="relative" h="100vh" overflow="hidden">
      <Box
        ref={stageRef}
        position="absolute"
        inset="0"
        overflow="hidden"
        willChange="transform"
        style={{ background: P.night }}
        boxShadow="0 40px 120px rgba(0,0,0,0.45)"
      >
        <Canvas ref={canvasRef} position="absolute" inset="0" w="full" h="full" display="block" aria-hidden="true" />

        {/* Chapter copy — every chapter shares one grid cell and crossfades */}
        <Box
          position="absolute"
          left={{ base: "6", lg: "6vw" }}
          right={{ base: "6", lg: "auto" }}
          top={{ base: "9vh", lg: "50%" }}
          transform={{ lg: "translateY(-50%)" }}
          w={{ lg: "22vw" }}
          maxW={{ lg: "380px" }}
          display="grid"
        >
          <Stack
            gap="4"
            gridArea="1 / 1"
            opacity={chapter === -1 ? 1 : 0}
            transform={chapter === -1 ? "none" : "translateY(-12px)"}
            transition="opacity 450ms ease, transform 550ms ease"
            aria-hidden={chapter !== -1}
          >
            <Text textStyle="eyebrow" style={{ color: P.fgMuted }}>
              How it works
            </Text>
            <Heading as="h2" textStyle="display" fontSize={{ base: "30px", lg: "clamp(30px, 2.9vw, 46px)" }} style={{ color: P.fg }}>
              From recording to published clips.
            </Heading>
            <Text fontSize="15px" lineHeight="1.65" style={{ color: P.fgMuted }} _motionReduce={{ display: "none" }}>
              Scroll to walk one episode through the whole pipeline.
            </Text>
            <Text fontSize="15px" lineHeight="1.65" style={{ color: P.fgMuted }} display="none" _motionReduce={{ display: "block" }}>
              Pick a stage below to walk one episode through the whole pipeline.
            </Text>
          </Stack>
          {CHAPTERS.map((c, i) => (
            <Stack
              key={c.title}
              gap="4"
              gridArea="1 / 1"
              opacity={chapter === i ? 1 : 0}
              transform={chapter === i ? "none" : chapter > i ? "translateY(-12px)" : "translateY(12px)"}
              transition="opacity 450ms ease, transform 550ms ease"
              aria-hidden={chapter !== i}
            >
              <Text textStyle="eyebrow" style={{ color: P.accentSoft }}>
                {String(i + 1).padStart(2, "0")} / {String(CHAPTERS.length).padStart(2, "0")} · {STEPS[i]!.label}
              </Text>
              <Heading as="h3" textStyle="display" fontSize={{ base: "28px", lg: "clamp(28px, 2.7vw, 44px)" }} style={{ color: P.fg }}>
                {c.title}
              </Heading>
              <Text fontSize="15px" lineHeight="1.65" style={{ color: P.fgMuted }}>
                {c.body}
              </Text>
            </Stack>
          ))}
        </Box>

        {/* Chapter rail: progress + jump links */}
        <Box position="absolute" left={{ base: "6", lg: "6vw" }} right={{ base: "6", lg: "6vw" }} bottom={{ base: "5vh", lg: "6vh" }}>
          <Box position="relative" h="2px" style={{ background: "rgba(255,255,255,0.12)" }}>
            <Box
              ref={railRef}
              position="absolute"
              inset="0"
              transformOrigin="left"
              style={{ background: P.accent, transform: "scaleX(0)" }}
            />
          </Box>
          <Flex justify="space-between" mt="3">
            {STEPS.map((step, i) => (
              <chakra.button
                key={step.label}
                type="button"
                onClick={() => goTo(i)}
                display="flex"
                alignItems="center"
                gap="2"
                py="1"
                cursor="pointer"
                aria-current={chapter === i ? "step" : undefined}
                _focusVisible={{ outline: "2px solid", outlineColor: "studio.ring", outlineOffset: "3px" }}
              >
                <Box
                  w="8px"
                  h="8px"
                  transition="background 300ms ease, box-shadow 300ms ease"
                  style={{
                    background: chapter >= i ? P.accent : "transparent",
                    border: `1.5px solid ${chapter >= i ? P.accent : "rgba(255,255,255,0.3)"}`,
                    boxShadow: chapter === i ? `0 0 14px ${P.accent}` : "none",
                  }}
                />
                <Text
                  textStyle="data"
                  fontSize="11px"
                  letterSpacing="0.12em"
                  textTransform="uppercase"
                  display={{ base: chapter === i ? "block" : "none", md: "block" }}
                  style={{ color: chapter === i ? P.fg : P.fgMuted }}
                >
                  {String(i + 1).padStart(2, "0")} {step.label}
                </Text>
              </chakra.button>
            ))}
          </Flex>
        </Box>
      </Box>
    </Box>
  );
}
