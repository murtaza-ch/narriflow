import { Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted" mb="3">
      {children}
    </Text>
  );
}

/** One account's header: round mark, name and handle, a count chip. */
function AccountHeader() {
  return (
    <Flex align="center" gap="3">
      <Bone boxSize="9" borderRadius="full" />
      <Stack gap="1.5" flex="1">
        <Bone h="4" w="28" />
        <Bone h="3" w="20" />
      </Stack>
      <Bone h="6" w="24" borderRadius="full" />
    </Flex>
  );
}

/** Publishing queue: a proposed-post card, then one account's week of posting slots. */
export default function PublishingQueueLoading() {
  return (
    <LoadingScreen label="Loading Publishing queue">
      <PageHeader
        title="Publishing queue"
        description="Posting slots for each account, and the posts waiting for you to accept them into one."
        actions={<Bone h="9" w="28" borderRadius="control" />}
      />
      <section>
        <SectionTitle>Proposed posts</SectionTitle>
        <Grid templateColumns={{ base: "1fr", xl: "repeat(2, minmax(0, 1fr))" }} gap="3">
          <Stack gap="4" bg="bg.subtle" borderRadius="l3" p={{ base: "4", md: "5" }}>
            <AccountHeader />
            <Flex align="center" gap="3">
              <Bone boxSize="10" borderRadius="l1" />
              <Stack gap="1.5" flex="1">
                <Bone h="4" w="40" maxW="90%" />
                <Bone h="3.5" w="28" />
              </Stack>
              <Bone h="6" w="12" borderRadius="full" />
            </Flex>
            <Bone h="20" borderRadius="control" />
            <Flex align="center" justify="space-between" gap="3" wrap="wrap">
              <Bone h="6" w="56" borderRadius="full" />
              <Flex gap="2">
                <Bone h="9" w="24" borderRadius="control" />
                <Bone h="9" w="24" borderRadius="control" />
              </Flex>
            </Flex>
          </Stack>
        </Grid>
      </section>
      <section>
        <SectionTitle>Posting schedule</SectionTitle>
        <Stack gap="3">
          <Bone h="3.5" w="xl" maxW="90%" />
          <Stack gap="4" bg="bg.subtle" borderRadius="l3" p={{ base: "4", md: "5" }}>
            <AccountHeader />
            <Grid templateColumns={{ base: "1fr", lg: "repeat(7, minmax(0, 1fr))" }} gap="2">
              {Array.from({ length: 7 }, (_, day) => (
                <Flex
                  key={day}
                  direction={{ base: "row", lg: "column" }}
                  align={{ base: "center", lg: "stretch" }}
                  gap={{ base: "3", lg: "2.5" }}
                  bg="bg.panel"
                  borderRadius="l2"
                  p="3"
                  minH={{ base: "14", lg: "32" }}
                >
                  <Bone h="4" w="9" />
                  <Flex direction={{ base: "row", lg: "column" }} gap="1.5" flex="1">
                    {day % 2 === 0 ? <Bone h="7" borderRadius="l1" w={{ base: "20", lg: "full" }} /> : null}
                  </Flex>
                  <Bone boxSize="8" borderRadius="control" w={{ lg: "full" }} />
                </Flex>
              ))}
            </Grid>
            <Bone h="9" w="32" borderRadius="control" />
          </Stack>
        </Stack>
      </section>
    </LoadingScreen>
  );
}
