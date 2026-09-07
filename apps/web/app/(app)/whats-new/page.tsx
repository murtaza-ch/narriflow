import { Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";

export default function WhatsNewPage() {
  return <Stack gap="8"><PageHeader title="What&apos;s new" /><Text fontSize="13px" color="fg.muted">Release notes will appear here as workspace features roll out.</Text></Stack>;
}
