import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

function SectionTitle({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Flex align="center" justify="space-between" gap="3" mb="3">
      <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted">
        {children}
      </Text>
      {action}
    </Flex>
  );
}

/**
 * Mirrors /integrations/mcp: back link, the connect header (logo to assistant,
 * title, status pill), the setup tabs card, prompt cards and capability cards.
 */
export default function Loading() {
  return (
    <LoadingScreen label="Loading assistant setup" gap="10" maxW="880px" mx="auto" pt={{ base: "2", md: "4" }}>
      <Bone h="9" w="28" borderRadius="control" alignSelf="flex-start" mb="-8" />

      <Stack gap="6">
        <Stack align="center" textAlign="center" gap="0">
          <Flex align="center" gap={{ base: "8", sm: "12" }} mb="5">
            <Bone boxSize="48px" borderRadius="14px" />
            <Bone boxSize="7" borderRadius="full" />
            <Bone boxSize="48px" borderRadius="14px" />
          </Flex>
          <Text as="h1" fontSize={{ base: "24px", md: "28px" }} fontWeight="500" letterSpacing="-0.02em">
            Connect your AI assistant
          </Text>
          <Text fontSize="14px" color="fg.muted" mt="1">
            Clip, review, export and schedule videos from chat.
          </Text>
          <Bone h="6" w="44" borderRadius="full" mt="4" />
        </Stack>

        <Stack gap="5" p={{ base: "3", md: "4" }} bg="bg.subtle" borderRadius="14px">
          <Flex gap="1" wrap="wrap">
            {[0, 1, 2, 3, 4, 5].map((tab) => (
              <Bone key={tab} h="8" w="24" borderRadius="9px" />
            ))}
          </Flex>
          <Stack gap="4" px={{ base: "1", md: "2" }}>
            {[0, 1, 2].map((step) => (
              <Flex key={step} gap="3" align="flex-start">
                <Bone boxSize="22px" borderRadius="full" flexShrink={0} />
                <Stack gap="2.5" flex="1" minW="0" pt="0.5">
                  <Bone h="4" w="96" maxW="full" my="0.5" />
                  {step === 1 ? <Bone h="11" borderRadius="12px" /> : null}
                </Stack>
              </Flex>
            ))}
            <Flex gap="2" mt="2" wrap="wrap">
              <Bone h="9" w="32" borderRadius="control" />
              <Bone h="9" w="28" borderRadius="control" />
            </Flex>
          </Stack>
        </Stack>
      </Stack>

      <section>
        <SectionTitle>Try a prompt</SectionTitle>
        <Grid templateColumns={{ base: "1fr", md: "repeat(3, minmax(0, 1fr))" }} gap="2">
          {[0, 1, 2].map((prompt) => (
            <Stack key={prompt} justify="space-between" gap="5" p="4" minH="28" bg="bg.subtle" borderRadius="12px">
              <Stack gap="1.5">
                <Bone h="4" w="full" />
                <Bone h="4" w="70%" />
              </Stack>
              <Flex align="center" justify="space-between">
                <Bone h="8" w="20" borderRadius="control" />
                <Bone boxSize="7" borderRadius="full" />
              </Flex>
            </Stack>
          ))}
        </Grid>
      </section>

      <section>
        <SectionTitle action={<Bone h="8" w="24" borderRadius="control" />}>What your assistant can do</SectionTitle>
        <Grid templateColumns={{ base: "1fr", sm: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))" }} gap="2">
          {[0, 1, 2, 3, 4, 5].map((capability) => (
            <Stack key={capability} gap="3" p="4" bg="bg.subtle" borderRadius="12px">
              <Bone boxSize="8" borderRadius="full" />
              <Stack gap="1">
                <Bone h="4" w="20" my="0.5" />
                <Bone h="4" w="full" my="0.5" />
              </Stack>
            </Stack>
          ))}
        </Grid>
      </section>

      <Flex gap={{ base: "2", md: "6" }} direction={{ base: "column", md: "row" }} pb="4">
        <Bone h="4" w="56" />
        <Bone h="4" w="40" />
      </Flex>
    </LoadingScreen>
  );
}
