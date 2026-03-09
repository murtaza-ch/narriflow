import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { SectionHeader } from "@narriflow/ui/components/section-header";
import { Stack, Box, Text, SimpleGrid, Flex } from "@chakra-ui/react";
import { Upload, Video } from "lucide-react";

export default function DashboardPage() {
  return (
    <Stack gap="32px">
      <SectionHeader
        title="Dashboard"
        description="Monitor ingest throughput, transcription health, and upcoming milestones."
        action={
          <Button asChild>
            <Link href="/upload">New Upload</Link>
          </Button>
        }
      />

      {/* Stats */}
      <SimpleGrid columns={{ base: 1, sm: 3 }} gap="16px">
        {[
          { label: "Total Projects", value: "---" },
          { label: "Processing", value: "---" },
          { label: "Completed", value: "---" },
        ].map((stat) => (
          <Box
            key={stat.label}
            borderRadius="12px"
            borderWidth="1px"
            borderColor="border"
            bg="bg.panel"
            p="20px"
          >
            <Text fontSize="13px" color="fg.muted">{stat.label}</Text>
            <Text fontSize="28px" fontWeight="600" color="fg" mt="4px" letterSpacing="-0.02em">
              {stat.value}
            </Text>
          </Box>
        ))}
      </SimpleGrid>

      {/* Quick actions */}
      <SimpleGrid columns={{ base: 1, sm: 2 }} gap="16px">
        <Box
          borderRadius="12px"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
          p="20px"
          transition="border-color 150ms ease"
          _hover={{ borderColor: "border.accent" }}
        >
          <Flex
            w="40px"
            h="40px"
            borderRadius="10px"
            bg="bg.muted"
            align="center"
            justify="center"
            color="fg.muted"
            mb="12px"
          >
            <Upload size={18} />
          </Flex>
          <Text fontSize="15px" fontWeight="600" color="fg">Upload Content</Text>
          <Text fontSize="13px" color="fg.muted" mt="4px" lineHeight="1.5">
            Upload audio or video files directly from your device.
          </Text>
          <Box mt="12px">
            <Button variant="outline" size="sm" asChild>
              <Link href="/upload">Upload File</Link>
            </Button>
          </Box>
        </Box>

        <Box
          borderRadius="12px"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
          p="20px"
          transition="border-color 150ms ease"
          _hover={{ borderColor: "border.accent" }}
        >
          <Flex
            w="40px"
            h="40px"
            borderRadius="10px"
            bg="bg.muted"
            align="center"
            justify="center"
            color="fg.muted"
            mb="12px"
          >
            <Video size={18} />
          </Flex>
          <Text fontSize="15px" fontWeight="600" color="fg">Import from YouTube</Text>
          <Text fontSize="13px" color="fg.muted" mt="4px" lineHeight="1.5">
            Paste a YouTube URL to import and transcribe automatically.
          </Text>
          <Box mt="12px">
            <Button variant="outline" size="sm" asChild>
              <Link href="/upload">Import Video</Link>
            </Button>
          </Box>
        </Box>
      </SimpleGrid>
    </Stack>
  );
}
