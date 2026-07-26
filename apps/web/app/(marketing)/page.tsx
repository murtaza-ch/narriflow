import { Fragment } from "react";
import Link from "next/link";
import {
  Box,
  Flex,
  Grid,
  GridItem,
  Heading,
  HStack,
  Stack,
  Text,
  VStack,
} from "@chakra-ui/react";
import {
  Captions,
  Gauge,
  RectangleHorizontal,
  Scissors,
  Share2,
  Wand2,
} from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { GhostFrame } from "@narriflow/ui/components/ghost-frame";
import { MediaWell } from "@narriflow/ui/components/media-well";
import { formatTimecode } from "@/lib/format";
import { HeroDemo } from "./_components/hero-demo";
import { PresetStrip } from "./_components/preset-strip";

const SIGNAL_STRIP = [
  "Word-accurate captions — preview = export",
  "9:16 · 1:1 · 16:9 · 4:5",
  "Virality-scored clips",
];

/** Mirrors the real worker pipeline: ingest → stt → moment_detection → clip_rendering → publish. */
const PIPELINE_STAGES = [
  {
    key: "ingest",
    title: "Ingest",
    description: "Upload a recording or paste a YouTube link. Audio extracted, media probed.",
  },
  {
    key: "stt",
    title: "Transcribe",
    description: "Word-level speech-to-text — the timing backbone for every caption.",
  },
  {
    key: "moment_detection",
    title: "Detect moments",
    description: "AI finds the clip-worthy moments and scores each one for virality.",
  },
  {
    key: "clip_rendering",
    title: "Render clips",
    description: "Captions burned in exactly as previewed, in every aspect ratio.",
  },
  {
    key: "publish",
    title: "Publish",
    description: "Schedule and post straight to your connected social accounts.",
  },
];

const RATIO_FRAMES = [
  { label: "9:16", ratio: 9 / 16, width: "27px" },
  { label: "1:1", ratio: 1, width: "48px" },
  { label: "16:9", ratio: 16 / 9, width: "84px" },
  { label: "4:5", ratio: 4 / 5, width: "38px" },
];

const REPURPOSE_ROWS = ["Blog post", "X thread", "LinkedIn post", "Show notes"];

function SectionHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id?: string;
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <Stack
      id={id}
      css={id ? { scrollMarginTop: "72px" } : undefined}
      gap="3"
      maxW="640px"
      layerStyle="band"
    >
      <Text textStyle="eyebrow" color="fg.subtle">
        {eyebrow}
      </Text>
      <Heading as="h2" textStyle="display" fontSize={{ base: "30px", md: "42px" }} color="fg">
        {title}
      </Heading>
      {description && (
        <Text fontSize="15px" color="fg.muted" lineHeight="1.7" maxW="56ch">
          {description}
        </Text>
      )}
    </Stack>
  );
}

/** Moment-detection vignette: candidate rows with mono timecodes + score meters. */
function MomentsVignette() {
  const rows = [
    { at: 761, score: 87, top: true },
    { at: 1523, score: 64, top: false },
    { at: 2204, score: 41, top: false },
  ];

  return (
    <Stack gap="0" w="full" maxW="320px" aria-hidden="true">
      {rows.map((row) => (
        <Flex
          key={row.at}
          align="center"
          gap="3"
          py="2"
          borderTopWidth="1px"
          borderColor="border.subtle"
        >
          <Box w="3px" alignSelf="stretch" bg={row.top ? "success.solid" : "border"} flexShrink={0} />
          <Text textStyle="data" fontSize="12px" color="fg.timecode">
            {formatTimecode(row.at)}
          </Text>
          <Box flex="1" h="3px" bg="bg.muted" borderRadius="full" overflow="hidden">
            <Box h="full" width={`${row.score}%`} bg={row.top ? "success.solid" : "fg.subtle"} />
          </Box>
          <Text textStyle="data" fontSize="12px" fontWeight="600" color={row.top ? "success.fg" : "fg.muted"}>
            {row.score}
          </Text>
        </Flex>
      ))}
    </Stack>
  );
}

/** Captions vignette: a static cue on graphite, one word highlighted. */
function CaptionsVignette() {
  return (
    <MediaWell ratio={16 / 9} maxW="280px" w="full" aria-hidden="true">
      <Flex position="absolute" inset="0" align="flex-end" justify="center" pb="4">
        <HStack gap="4px">
          <Text fontSize="12px" fontWeight="700" textTransform="uppercase" color="#FFFFFF">
            preview
          </Text>
          {/* Real karaoke-preset highlight color */}
          <Text fontSize="12px" fontWeight="700" textTransform="uppercase" color="#00FF88">
            equals
          </Text>
          <Text fontSize="12px" fontWeight="700" textTransform="uppercase" color="#FFFFFF">
            export
          </Text>
        </HStack>
      </Flex>
    </MediaWell>
  );
}

/** Aspect-ratio vignette: ghost frames of the four output formats. */
function RatiosVignette() {
  return (
    <Flex align="flex-end" gap="3" aria-hidden="true">
      {RATIO_FRAMES.map((frame) => (
        <Stack key={frame.label} gap="1.5" align="center">
          <GhostFrame ratio={frame.ratio} size={frame.width} />
          <Text textStyle="data" fontSize="10px" color="fg.subtle">
            {frame.label}
          </Text>
        </Stack>
      ))}
    </Flex>
  );
}

/** Reframe vignette: a dashed speaker-tracking crop inside the frame. */
function ReframeVignette() {
  return (
    <MediaWell ratio={16 / 9} maxW="280px" w="full" aria-hidden="true">
      <Box
        position="absolute"
        top="12%"
        bottom="12%"
        left="34%"
        w="30%"
        borderWidth="1.5px"
        borderStyle="dashed"
        borderColor="studio.accent"
        borderRadius="l1"
      />
      <Text
        position="absolute"
        bottom="6%"
        left="36%"
        textStyle="data"
        fontSize="9px"
        color="studio.fgMuted"
      >
        9:16 crop
      </Text>
    </MediaWell>
  );
}

/** Repurposing vignette: content-suite artifacts as hairline rows. */
function RepurposeVignette() {
  return (
    <Stack gap="0" w="full" maxW="280px" aria-hidden="true">
      {REPURPOSE_ROWS.map((row, index) => (
        <Flex
          key={row}
          align="center"
          justify="space-between"
          gap="3"
          py="2"
          borderTopWidth="1px"
          borderColor="border.subtle"
        >
          <Text fontSize="12.5px" color="fg">
            {row}
          </Text>
          <Text textStyle="data" fontSize="10px" color="fg.subtle">
            {String(index + 1).padStart(2, "0")}
          </Text>
        </Flex>
      ))}
    </Stack>
  );
}

/** Publishing vignette: a scheduled-post chip with mono datetime. */
function PublishVignette() {
  return (
    <Stack gap="2" aria-hidden="true">
      {[
        { platform: "TikTok", when: "Jul 8 · 09:00" },
        { platform: "YouTube Shorts", when: "Jul 8 · 12:30" },
      ].map((post) => (
        <Flex
          key={post.platform}
          align="center"
          gap="3"
          py="2"
          borderTopWidth="1px"
          borderColor="border.subtle"
        >
          <Box w="6px" h="6px" bg="success.solid" flexShrink={0} />
          <Text fontSize="12.5px" color="fg">
            {post.platform}
          </Text>
          <Text textStyle="data" fontSize="11px" color="fg.muted" ms="auto">
            {post.when}
          </Text>
        </Flex>
      ))}
    </Stack>
  );
}

const FEATURES = [
  {
    icon: Scissors,
    title: "AI moment detection",
    description: "Finds and scores the clip-worthy moments in your recording.",
    vignette: <MomentsVignette />,
    large: true,
  },
  {
    icon: Captions,
    title: "Word-synced captions",
    description: "12 presets and emoji captions that render exactly as previewed.",
    vignette: <CaptionsVignette />,
    large: true,
  },
  {
    icon: RectangleHorizontal,
    title: "Every aspect ratio",
    description: "9:16, 1:1, 16:9, and 4:5 renders from a single source clip.",
    vignette: <RatiosVignette />,
    large: false,
  },
  {
    icon: Wand2,
    title: "Auto-reframe + B-roll",
    description: "Speaker-tracking crops and stock B-roll cutaways, built in.",
    vignette: <ReframeVignette />,
    large: false,
  },
  {
    icon: Gauge,
    title: "Content-suite repurposing",
    description: "Blog posts, X threads, LinkedIn posts, and show notes from one transcript.",
    vignette: <RepurposeVignette />,
    large: false,
  },
  {
    icon: Share2,
    title: "Direct publishing",
    description: "Schedule and publish straight to your connected social accounts.",
    vignette: <PublishVignette />,
    large: false,
  },
];

const stagger = (step: number) => ({ animationDelay: `${step * 70}ms` });

export default function MarketingHomePage() {
  return (
    <Box as="main" position="relative">
      {/* ————— Hero ————— */}
      <Box position="relative" overflow="hidden">
        {/* Blueprint-grid ambient, radially masked */}
        <Box
          aria-hidden="true"
          position="absolute"
          inset="0"
          layerStyle="blueprint"
          pointerEvents="none"
          maskImage="radial-gradient(ellipse 62% 58% at 50% 30%, black 0%, transparent 74%)"
        />

        <VStack
          position="relative"
          mx="auto"
          w="full"
          maxW="1200px"
          px="6"
          justify="center"
          gap="0"
          textAlign="center"
          pt={{ base: "16", md: "24" }}
          pb="14"
        >
          {/* Eyebrow over a drawn rule */}
          <Stack
            gap="2"
            align="center"
            mb="7"
            animation="fade-up"
            animationFillMode="backwards"
            style={stagger(0)}
          >
            <Text textStyle="eyebrow" color="fg.muted">
              AI clip studio
            </Text>
            <Box h="1.5px" w="7" bg="fg" animation="rule-in" />
          </Stack>

          {/* Headline */}
          <Heading
            as="h1"
            maxW="880px"
            textStyle="display"
            fontSize={{ base: "40px", sm: "52px", md: "64px", lg: "72px" }}
            color="fg"
            animation="fade-up"
            animationFillMode="backwards"
            style={stagger(1)}
          >
            Turn one long recording into viral clips, threads, and blog posts
            <Box as="span" color="accent.solid">
              .
            </Box>
          </Heading>

          {/* Subcopy */}
          <Text
            maxW="560px"
            fontSize={{ base: "15px", md: "17px" }}
            lineHeight="1.65"
            color="fg.muted"
            mt="6"
            animation="fade-up"
            animationFillMode="backwards"
            style={stagger(2)}
          >
            Narriflow runs the whole pipeline — ingest, transcription, moment
            detection, captioned rendering, and publishing — from one workflow.
          </Text>

          {/* CTAs: one solid button; the secondary path is an ink link */}
          <HStack gap="6" mt="9" animation="fade-up" animationFillMode="backwards" style={stagger(3)}>
            <Button size="lg" px="7" asChild>
              <Link href="/sign-up">Start for free</Link>
            </Button>
            <Link href="/pricing">
              <Text
                as="span"
                fontSize="14px"
                fontWeight="500"
                color="fg"
                textDecoration="underline"
                textUnderlineOffset="4px"
                textDecorationColor="border.emphasized"
                transition="text-decoration-color 120ms ease"
                _hover={{ textDecorationColor: "fg" }}
              >
                View pricing →
              </Text>
            </Link>
          </HStack>

          {/* Signal strip — mono microcaps between hairlines */}
          <Flex
            mt="12"
            px="5"
            py="3"
            gap={{ base: "2.5", md: "4" }}
            align="center"
            justify="center"
            flexWrap="wrap"
            borderTopWidth="1px"
            borderBottomWidth="1px"
            borderColor="border.subtle"
            animation="fade-up"
            animationFillMode="backwards"
            style={stagger(4)}
          >
            {SIGNAL_STRIP.map((signal, i) => (
              <Fragment key={signal}>
                {i > 0 && (
                  <Text
                    aria-hidden="true"
                    textStyle="eyebrow"
                    color="fg.subtle"
                    display={{ base: "none", sm: "block" }}
                  >
                    {"//"}
                  </Text>
                )}
                <Text textStyle="eyebrow" color="fg.muted" whiteSpace="nowrap">
                  {signal}
                </Text>
              </Fragment>
            ))}
          </Flex>

          {/* Product visual: LIVE caption-cue loop on the real cue model */}
          <Box
            w="full"
            maxW="960px"
            mt="16"
            animation="fade-up"
            animationFillMode="backwards"
            style={stagger(5)}
          >
            <HeroDemo />
          </Box>
        </VStack>
      </Box>

      {/* ————— Pipeline: the drawn stepper ————— */}
      <Box mx="auto" w="full" maxW="1200px" px="6" pt={{ base: "16", md: "24" }}>
        <SectionHeading
          id="pipeline"
          eyebrow="How it works"
          title="Five stages. Zero timelines to babysit."
          description="The same worker pipeline that powers the app, drawn end to end. Drop a recording at stage one; collect scheduled posts at stage five."
        />

        <Grid
          templateColumns={{ base: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(5, 1fr)" }}
          columnGap="8"
          rowGap="10"
          mt="10"
        >
          {PIPELINE_STAGES.map((stage, index) => (
            <Stack key={stage.key} gap="2" position="relative" borderTopWidth="1px" borderColor="border" pt="4">
              {/* Square node pinned to the rule */}
              <Box position="absolute" top="-3.5px" left="0" w="6px" h="6px" bg="fg" />
              <Text textStyle="data" fontSize="11px" color="fg.subtle">
                {String(index + 1).padStart(2, "0")} · {stage.key}
              </Text>
              <Text textStyle="title" fontSize="17px" color="fg">
                {stage.title}
              </Text>
              <Text fontSize="13px" color="fg.muted" lineHeight="1.6">
                {stage.description}
              </Text>
            </Stack>
          ))}
        </Grid>
      </Box>

      {/* ————— Caption presets: real presets, live loop ————— */}
      <Box mx="auto" w="full" maxW="1200px" px="6" pt={{ base: "16", md: "24" }}>
        <SectionHeading
          eyebrow="Caption presets"
          title="Twelve styles, rendered honestly."
          description="These tiles run on the exact preset definitions the renderer burns in — same colors, same casing, same word-by-word timing."
        />
        <Box mt="10">
          <PresetStrip />
        </Box>
      </Box>

      {/* ————— Features: editorial asymmetric grid with product vignettes ————— */}
      <Box
        as="section"
        id="features"
        css={{ scrollMarginTop: "72px" }}
        mx="auto"
        w="full"
        maxW="1200px"
        px="6"
        pt={{ base: "16", md: "24" }}
        pb={{ base: "20", md: "28" }}
      >
        <SectionHeading eyebrow="Capabilities" title="The whole pipeline, one workflow." />

        <Grid
          templateColumns={{ base: "1fr", sm: "repeat(2, 1fr)", lg: "repeat(4, 1fr)" }}
          columnGap="8"
          rowGap="12"
          mt="10"
        >
          {FEATURES.map(({ icon: Icon, title, description, vignette, large }, i) => (
            <GridItem
              key={title}
              colSpan={{ base: 1, sm: large ? 2 : 1, lg: large ? 2 : 1 }}
            >
              <Stack gap="4" h="full" borderTopWidth="1px" borderColor="border" pt="4">
                <Flex align="center" justify="space-between" gap="3">
                  <HStack gap="2.5" color="fg" minW="0">
                    <Flex color="fg.muted" flexShrink={0} aria-hidden="true">
                      <Icon size={16} strokeWidth={1.75} />
                    </Flex>
                    <Text textStyle="title" fontSize={large ? "18px" : "15.5px"} truncate>
                      {title}
                    </Text>
                  </HStack>
                  <Text textStyle="data" fontSize="11px" color="fg.subtle" flexShrink={0}>
                    {String(i + 1).padStart(2, "0")}
                  </Text>
                </Flex>
                <Text fontSize="13px" color="fg.muted" lineHeight="1.65" maxW="44ch">
                  {description}
                </Text>
                <Flex flex="1" align="flex-end" pt="2">
                  {vignette}
                </Flex>
              </Stack>
            </GridItem>
          ))}
        </Grid>
      </Box>

      {/* ————— Closing CTA band ————— */}
      <Box mx="auto" w="full" maxW="1200px" px="6" pb={{ base: "20", md: "28" }}>
        <Box
          position="relative"
          overflow="hidden"
          borderRadius="l3"
          bg="bg.inverted"
          px={{ base: "8", md: "16" }}
          py={{ base: "14", md: "20" }}
          textAlign="center"
        >
          <VStack position="relative" gap="0">
            <Stack gap="2" align="center" mb="5">
              <Text textStyle="eyebrow" color="fg.inverted" opacity="0.6">
                Free plan available
              </Text>
              <Box h="1.5px" w="7" bg="fg.inverted" opacity="0.5" />
            </Stack>
            <Heading
              as="h2"
              textStyle="display"
              fontSize={{ base: "30px", md: "44px" }}
              color="fg.inverted"
              maxW="560px"
            >
              Press record on your next hundred posts.
            </Heading>
            <Text
              fontSize={{ base: "14px", md: "15px" }}
              color="fg.inverted"
              opacity="0.65"
              mt="4"
              maxW="440px"
              lineHeight="1.65"
            >
              Start on the free plan and test the whole workflow — upgrade only
              when you need more processing minutes.
            </Text>
            <HStack gap="6" mt="8">
              <Button size="lg" px="7" asChild>
                <Link href="/sign-up">Get started free</Link>
              </Button>
              <Link href="/pricing">
                <Text
                  as="span"
                  fontSize="14px"
                  fontWeight="500"
                  color="fg.inverted"
                  textDecoration="underline"
                  textUnderlineOffset="4px"
                  opacity="0.75"
                  transition="opacity 120ms ease"
                  _hover={{ opacity: 1 }}
                >
                  View pricing →
                </Text>
              </Link>
            </HStack>
          </VStack>
        </Box>
      </Box>
    </Box>
  );
}
