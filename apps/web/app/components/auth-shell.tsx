import Link from "next/link";
import { Box, Flex, HStack, Stack, Text } from "@chakra-ui/react";
import { Logo } from "@narriflow/ui/components/logo";

interface AuthShellProps {
  children: React.ReactNode;
  /** Form column width. Default 420px — keep identical across the funnel. */
  maxW?: string;
  /** Optional slot rendered under the form (e.g. a tagline eyebrow). */
  footer?: React.ReactNode;
}

const PIPELINE_STEPS = [
  { n: "01", label: "Upload" },
  { n: "02", label: "Detect moments" },
  { n: "03", label: "Publish" },
];

/** Caption-preview vignette words — index 2 is the "spoken" word. */
const CAPTION_WORDS = ["clips", "that", "hook", "in", "seconds"];
const ACTIVE_WORD_INDEX = 2;

/**
 * AuthShell — the one chrome for the whole entry funnel: (auth) routes,
 * /sso-callback, and /onboarding. Split composition on lg: a graphite-subtle
 * brand rail (blueprint ambient, product line, caption-preview vignette,
 * pipeline steps) beside the form on clean bg. Collapses to a centered
 * single column with the logo up top on smaller screens.
 * Server-component friendly.
 */
export function AuthShell({ children, maxW = "420px", footer }: AuthShellProps) {
  return (
    <Flex as="main" minH="100svh" bg="bg" color="fg">
      {/* ——— Brand rail (lg and up) ——— */}
      <Flex
        display={{ base: "none", lg: "flex" }}
        direction="column"
        justify="space-between"
        gap="10"
        w="46%"
        maxW="640px"
        p="10"
        bg="bg.subtle"
        borderRightWidth="1px"
        borderRightColor="border"
        position="sticky"
        top="0"
        h="100svh"
        overflow="hidden"
      >
        {/* Blueprint ambient — fades at center (under copy) and at the edges */}
        <Box
          aria-hidden="true"
          position="absolute"
          inset="0"
          layerStyle="blueprint"
          maskImage="radial-gradient(ellipse 75% 75% at center, transparent 22%, black 55%, transparent 100%)"
          pointerEvents="none"
        />

        <Box position="relative" animation="fade-up" animationFillMode="backwards">
          <Link href="/" aria-label="Narriflow home">
            <Logo size="lg" />
          </Link>
        </Box>

        <Stack
          position="relative"
          gap="8"
          maxW="400px"
          animation="fade-up"
          animationDelay="60ms"
          animationFillMode="backwards"
        >
          <Stack gap="2.5">
            <Text textStyle="eyebrow" color="fg.subtle">
              Clip studio
            </Text>
            <Box h="1.5px" w="8" bg="border.strong" animation="rule-in" />
            <Text
              textStyle="display"
              fontSize={{ base: "28px", xl: "32px" }}
              color="fg"
              pt="1"
            >
              Long recordings in.
              <br />
              Social-ready clips out.
            </Text>
          </Stack>

          {/* Caption-preview vignette — a quiet echo of the product output */}
          <Stack
            gap="3"
            w="fit-content"
            minW="280px"
            p="4"
            bg="bg"
            borderWidth="1px"
            borderColor="border"
            borderRadius="l2"
          >
            <Flex align="baseline" justify="space-between" gap="4">
              <Text textStyle="eyebrow" color="fg.subtle">
                Caption preview
              </Text>
              <Text textStyle="data" fontSize="11px" color="fg.timecode">
                00:12.4
              </Text>
            </Flex>
            <HStack gap="1.5" wrap="wrap">
              {CAPTION_WORDS.map((word, index) =>
                index === ACTIVE_WORD_INDEX ? (
                  <Text
                    key={word}
                    fontFamily="display"
                    fontWeight="650"
                    fontSize="15px"
                    lineHeight="1.4"
                    color="accent.fg"
                    bg="accent.muted"
                    px="1.5"
                    borderRadius="l1"
                  >
                    {word}
                  </Text>
                ) : (
                  <Text
                    key={word}
                    fontFamily="display"
                    fontWeight="650"
                    fontSize="15px"
                    lineHeight="1.4"
                    color="fg"
                  >
                    {word}
                  </Text>
                ),
              )}
            </HStack>
            <Flex align="center" gap="3">
              <Box
                flex="1"
                h="3px"
                bg="bg.muted"
                borderRadius="full"
                overflow="hidden"
              >
                <Box h="full" w="38%" bg="accent.solid" animation="meter-fill" />
              </Box>
              <Text textStyle="data" fontSize="11px" color="fg.subtle">
                0:31
              </Text>
            </Flex>
          </Stack>
        </Stack>

        {/* Pipeline steps — drawn band, not a box */}
        <HStack
          position="relative"
          gap="7"
          pt="4"
          borderTopWidth="1.5px"
          borderTopColor="border.strong"
          animation="fade-up"
          animationDelay="120ms"
          animationFillMode="backwards"
        >
          {PIPELINE_STEPS.map((step) => (
            <HStack key={step.n} gap="2">
              <Text textStyle="data" fontSize="11px" color="fg.subtle">
                {step.n}
              </Text>
              <Text fontSize="12px" color="fg.muted">
                {step.label}
              </Text>
            </HStack>
          ))}
        </HStack>
      </Flex>

      {/* ——— Form column — clean bg, no card chrome ——— */}
      <Flex flex="1" align="center" justify="center" px="6" py="10">
        <Stack gap="8" w="full" maxW={maxW}>
          {/* Logo appears here only when the brand rail is hidden */}
          <Flex
            display={{ base: "flex", lg: "none" }}
            justify="center"
            animation="fade-up"
            animationFillMode="backwards"
          >
            <Link href="/" aria-label="Narriflow home">
              <Logo size="lg" />
            </Link>
          </Flex>
          <Box animation="fade-up" animationDelay="80ms" animationFillMode="backwards">
            {children}
          </Box>
          {footer && <Flex justify="center">{footer}</Flex>}
        </Stack>
      </Flex>
    </Flex>
  );
}

interface AuthHeaderProps {
  /** Small caps voice above the drawn rule, e.g. "Welcome back". */
  eyebrow: string;
  title: string;
  description?: React.ReactNode;
}

/**
 * AuthHeader — the shared header rhythm for every funnel screen: eyebrow,
 * a short 1.5px rule that draws in, then a display-voice title and muted
 * description. Left-aligned to sit naturally in the split composition.
 */
export function AuthHeader({ eyebrow, title, description }: AuthHeaderProps) {
  return (
    <Stack gap="2.5" align="flex-start">
      <Text textStyle="eyebrow" color="fg.subtle">
        {eyebrow}
      </Text>
      <Box h="1.5px" w="7" bg="border.strong" animation="rule-in" />
      <Stack gap="1.5" pt="1">
        <Text as="h1" textStyle="display" fontSize="26px" color="fg">
          {title}
        </Text>
        {description && (
          <Text fontSize="14px" color="fg.muted" lineHeight="1.55">
            {description}
          </Text>
        )}
      </Stack>
    </Stack>
  );
}
