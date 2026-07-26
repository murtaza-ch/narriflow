import type { Metadata } from "next";
import { Heading, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { formatDate } from "@/lib/format";

export const metadata: Metadata = {
  title: "Terms of service",
  description: "The terms that govern your use of Narriflow.",
};

const LAST_UPDATED = formatDate(new Date(2026, 6, 7));

const SECTIONS = [
  {
    title: "The service",
    body: "Narriflow turns long-form recordings into short captioned clips and repurposed content, and can publish to social accounts you connect. Plans are metered in processing minutes — one minute of source media consumes one processing minute.",
  },
  {
    title: "Your content",
    body: "You keep all rights to media you upload and to the clips and content generated from it. You must have the rights to any media you process, and you are responsible for what you publish through connected accounts.",
  },
  {
    title: "Acceptable use",
    body: "Don't process content you don't have rights to, attempt to circumvent quotas or watermarks, or use the service to produce unlawful or deceptive content. We may suspend accounts that do.",
  },
  {
    title: "Billing",
    body: "Paid plans renew monthly or annually until cancelled. Quota resets each billing period; unused minutes do not roll over. You can cancel any time from billing settings, effective at the end of the current period.",
  },
  {
    title: "Warranty and liability",
    body: "The service is provided as-is. AI-generated scores, captions, and repurposed content can contain mistakes — review before publishing. To the extent permitted by law, our liability is limited to the fees you paid in the preceding twelve months.",
  },
];

export default function TermsPage() {
  return (
    <Stack as="main" mx="auto" w="full" maxW="760px" px="6" pt={{ base: "14", md: "20" }} pb="24" gap="10">
      <PageHeader
        eyebrow="Legal"
        title="Terms of service"
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
