import { Flex, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

function SectionTitle({ children }: { children: React.ReactNode }) {
  return (
    <Text as="h2" fontSize="14px" fontWeight="500" color="fg.muted" mb="3">
      {children}
    </Text>
  );
}

/** Publishing queue: a proposed-post card, then one account's weekly posting schedule. */
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
        <Stack gap="3" bg="bg.subtle" borderRadius="l3" p="4">
          <Flex align="center" gap="2.5">
            <Bone boxSize="6" />
            <Bone h="4" w="28" />
            <Bone h="3.5" w="20" />
            <Bone h="3" w="32" ml="auto" />
          </Flex>
          <Bone h="3.5" w="72" maxW="90%" />
          <Bone h="20" borderRadius="control" />
          <Flex align="center" justify="space-between" gap="3" wrap="wrap">
            <Bone h="3.5" w="48" />
            <Flex gap="2">
              <Bone h="9" w="24" borderRadius="control" />
              <Bone h="9" w="24" borderRadius="control" />
            </Flex>
          </Flex>
        </Stack>
      </section>
      <section>
        <SectionTitle>Posting schedule</SectionTitle>
        <Stack gap="3">
          <Bone h="3.5" w="xl" maxW="90%" />
          <Stack gap="3.5" bg="bg.subtle" borderRadius="l3" p="4">
            <Flex align="center" gap="2.5">
              <Bone boxSize="6" />
              <Bone h="4" w="28" />
              <Bone h="3.5" w="20" />
            </Flex>
            <Stack gap="1">
              {WEEKDAYS.map((weekday, index) => (
                <Flex key={weekday} align="center" gap="3" minH="9">
                  <Text fontSize="13px" color="fg.muted" w="24">
                    {weekday}
                  </Text>
                  <Flex gap="1.5" flex="1">
                    {index % 2 === 0 ? <Bone h="7" w="20" borderRadius="l2" /> : null}
                  </Flex>
                  <Bone boxSize="8" borderRadius="control" />
                </Flex>
              ))}
            </Stack>
            <Bone h="9" w="32" borderRadius="control" />
          </Stack>
        </Stack>
      </section>
    </LoadingScreen>
  );
}
