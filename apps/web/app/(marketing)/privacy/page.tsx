import type { Metadata } from "next";
import { Heading, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Privacy policy",
  description: "How Narriflow handles your account data, media, and transcripts.",
};

const LAST_UPDATED = formatDate(new Date(2026, 6, 7));

const SECTIONS = [
  {
    title: "What we collect",
    body: "Your account details (name, email) via our authentication provider, the media you upload or link, the transcripts and clips generated from it, and billing status via our payment provider. We do not sell personal data.",
  },
  {
    title: "How your media is used",
    body: "Uploaded recordings are processed solely to deliver the product: transcription, moment detection, clip rendering, repurposing, dubbing, and publishing to accounts you connect. Your media is not used to train models.",
  },
  {
    title: "Storage and deletion",
    body: "Media and derived assets are stored with our cloud storage provider and removed when you delete a project or your account. Deleting your account marks all associated data for removal.",
  },
  {
    title: "Third parties",
    body: "We rely on processors for authentication, payments, storage, transcription, and AI analysis, each bound by their own data-processing terms. Social publishing only touches accounts you explicitly connect, and you can disconnect them at any time.",
  },
  {
    title: "Contact",
    body: "Questions about this policy or a data request? Email us and we will respond promptly.",
  },
];

export default function PrivacyPage() {
  return (
    <Stack as="main" mx="auto" w="full" maxW="760px" px="6" pt={{ base: "14", md: "20" }} pb="24" gap="10">
      <PageHeader
        eyebrow="Legal"
        title="Privacy policy"
        description={`Last updated ${LAST_UPDATED}`}
      />

      <Stack gap="8">
        {SECTIONS.map((section) => (
          <Stack key={section.title} gap="2" layerStyle="band">
            <Heading as="h2" textStyle="title" fontSize="17px">
              {section.title}
            </Heading>
            <Text fontSize="14px" color="fg.muted" lineHeight="1.75">
              {section.body}
            </Text>
          </Stack>
        ))}
      </Stack>
    </Stack>
  );
}
