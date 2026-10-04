import { Fragment } from "react";
import Link from "next/link";
import { Box, Flex, Heading, HStack, Stack, Text, VStack } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { SmoothScroll } from "@/app/_components/smooth-scroll";
import { CapabilityGallery } from "./_components/capability-gallery";
import { CaptionPlayground } from "./_components/caption-playground";
import { ClosingStage } from "./_components/closing-stage";
import { CursorGlow, Magnetic } from "./_components/hero-motion";
import { PipelineWorld } from "./_components/pipeline-world";

const HEADLINE = "Turn one long recording into viral clips, threads, and blog posts";

const SIGNAL_STRIP = [
  "Word-accurate captions — preview = export",
  "9:16 · 1:1 · 16:9 · 4:5",
  "Virality-scored clips",
];

const stagger = (step: number) => ({ animationDelay: `${step * 70}ms` });

export default function MarketingHomePage() {
  const words = HEADLINE.split(" ");

  return (
    <SmoothScroll>
      <Box as="main" position="relative">
        {/* ————— Hero ————— */}
        <Box position="relative" overflow="hidden">
          {/* Blueprint-grid ambient, radially masked; lit under the cursor */}
          <Box
            aria-hidden="true"
            position="absolute"
            inset="0"
            layerStyle="blueprint"
            pointerEvents="none"
            maskImage="radial-gradient(ellipse 62% 58% at 50% 30%, black 0%, transparent 74%)"
          />
          <CursorGlow />

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
            pb={{ base: "12", md: "16" }}
          >
            {/* Eyebrow over a drawn rule */}
            <Stack gap="2" align="center" mb="7" animation="fade-up" animationFillMode="backwards" style={stagger(0)}>
              <Text textStyle="eyebrow" color="fg.muted">
                AI clip studio
              </Text>
              <Box h="1.5px" w="7" bg="fg" animation="rule-in" />
            </Stack>

            {/* Headline, revealed word by word */}
            <Heading
              as="h1"
              maxW="880px"
              textStyle="display"
              fontSize={{ base: "40px", sm: "52px", md: "64px", lg: "72px" }}
              color="fg"
            >
              {words.map((word, i) => (
                <Fragment key={`${word}-${i}`}>
                  <Box
                    as="span"
                    display="inline-block"
                    animation="fade-up"
                    animationFillMode="backwards"
                    style={{ animationDelay: `${90 + i * 55}ms` }}
                  >
                    {word}
                    {i === words.length - 1 && (
                      <Box as="span" color="accent.solid">
                        .
                      </Box>
                    )}
                  </Box>{" "}
                </Fragment>
              ))}
            </Heading>

            <Text
              maxW="560px"
              fontSize={{ base: "15px", md: "17px" }}
              lineHeight="1.65"
              color="fg.muted"
              mt="6"
              animation="fade-up"
              animationFillMode="backwards"
              style={stagger(8)}
            >
              Narriflow runs the whole pipeline — ingest, transcription, moment detection, captioned rendering, and
              publishing — from one workflow.
            </Text>

            {/* CTAs: one solid button; the secondary path is an ink link */}
            <HStack gap="6" mt="9" animation="fade-up" animationFillMode="backwards" style={stagger(9)}>
              <Magnetic>
                <Button size="lg" px="7" asChild>
                  <Link href="/sign-up">Start for free</Link>
                </Button>
              </Magnetic>
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
              style={stagger(10)}
            >
              {SIGNAL_STRIP.map((signal, i) => (
                <Fragment key={signal}>
                  {i > 0 && (
                    <Text aria-hidden="true" textStyle="eyebrow" color="fg.subtle" display={{ base: "none", sm: "block" }}>
                      {"//"}
                    </Text>
                  )}
                  <Text textStyle="eyebrow" color="fg.muted" whiteSpace="nowrap">
                    {signal}
                  </Text>
                </Fragment>
              ))}
            </Flex>
          </VStack>
        </Box>

        {/* ————— World 1: the pipeline, scrubbed by scroll ————— */}
        <PipelineWorld />

        {/* ————— Caption playground ————— */}
        <Box mx="auto" w="full" maxW="1200px" px="6" pt={{ base: "20", md: "28" }}>
          <Stack gap="3" maxW="640px" layerStyle="band" mb="10">
            <Text textStyle="eyebrow" color="fg.subtle">
              Caption presets
            </Text>
            <Heading as="h2" textStyle="display" fontSize={{ base: "30px", md: "42px" }} color="fg">
              Twelve caption styles. Try them.
            </Heading>
            <Text fontSize="15px" color="fg.muted" lineHeight="1.7" maxW="56ch">
              Hover a preset to preview it, then type your own line. Every word lands on time, exactly as it will
              export.
            </Text>
          </Stack>
          <CaptionPlayground />
        </Box>

        {/* ————— World 2: capabilities, a horizontal gallery ————— */}
        <Box pt={{ base: "12", md: "16" }}>
          <CapabilityGallery />
        </Box>

        {/* ————— Closing CTA on a live stage ————— */}
        <Box mx="auto" w="full" maxW="1200px" px="6" pt={{ base: "16", md: "20" }} pb={{ base: "20", md: "28" }}>
          <Box
            position="relative"
            overflow="hidden"
            borderRadius="l3"
            bg="studio.canvas"
            px={{ base: "8", md: "16" }}
            py={{ base: "16", md: "24" }}
            textAlign="center"
          >
            <ClosingStage />
            <VStack position="relative" gap="0">
              <Stack gap="2" align="center" mb="5">
                <Text textStyle="eyebrow" color="studio.fgMuted">
                  Free plan available
                </Text>
                <Box h="1.5px" w="7" bg="studio.fg" opacity="0.5" />
              </Stack>
              <Heading as="h2" textStyle="display" fontSize={{ base: "30px", md: "44px" }} color="studio.fg" maxW="560px">
                Press record on your next hundred posts.
              </Heading>
              <Text fontSize={{ base: "14px", md: "15px" }} color="studio.fgMuted" mt="4" maxW="440px" lineHeight="1.65">
                Start on the free plan and test the whole workflow — upgrade only when you need more processing
                minutes.
              </Text>
              <HStack gap="6" mt="8">
                <Magnetic>
                  <Button size="lg" px="7" asChild>
                    <Link href="/sign-up">Get started free</Link>
                  </Button>
                </Magnetic>
                <Link href="/pricing">
                  <Text
                    as="span"
                    fontSize="14px"
                    fontWeight="500"
                    color="studio.fg"
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
    </SmoothScroll>
  );
}
