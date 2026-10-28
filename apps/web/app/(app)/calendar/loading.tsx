import { Box, Flex, Grid, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { Bone, LoadingScreen } from "@narriflow/ui/components/page-loading";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const FILTER_WIDTHS = ["170px", "170px", "190px", "220px"];

/** Calendar, month view: header actions, period + view controls, the four filters, and a five-week grid. */
export default function CalendarLoading() {
  return (
    <LoadingScreen label="Loading Calendar" gap="6">
      <Box mb="2">
        <PageHeader
          title="Calendar"
          actions={
            <>
              <Bone h="9" w="84px" borderRadius="control" />
              <Bone h="9" w="32" borderRadius="control" />
            </>
          }
        />
      </Box>

      <Flex align="center" justify="space-between" gap="3" wrap="wrap">
        <Flex align="center" gap="3" wrap="wrap">
          <Bone h="10" w="152px" borderRadius="control" />
          <Bone h="6" w="32" />
          <Bone h="6" w="28" borderRadius="full" />
        </Flex>
        <Bone h="9" w="56" borderRadius="control" />
      </Flex>

      <Flex gap="2" wrap="wrap" align="center">
        {FILTER_WIDTHS.map((width, index) => (
          <Bone key={index} h="9" w={width} borderRadius="control" />
        ))}
      </Flex>

      <Box overflowX="auto" mx="-1" px="1" pb="1">
        <Grid templateColumns="repeat(7, minmax(120px, 1fr))" minW="840px" gap="1.5">
          {WEEKDAYS.map((label) => (
            <Text key={label} px="3" pb="1" fontSize="12px" fontWeight="500" color="fg.subtle">
              {label}
            </Text>
          ))}
          {Array.from({ length: 35 }, (_, index) => (
            <Stack key={index} gap="1.5" minH="118px" p="2" borderRadius="l2" bg="bg.subtle">
              <Bone boxSize="6" borderRadius="full" />
            </Stack>
          ))}
        </Grid>
      </Box>
    </LoadingScreen>
  );
}
