import { Box, Stack, Text } from "@chakra-ui/react";
import { PageHeader } from "@narriflow/ui/components/page-header";

export default function HelpPage() {
  return <Stack gap="8"><PageHeader eyebrow="Learn" title="Tutorials &amp; help" description="Learn the fastest path from source video to a published short." /><Box borderTopWidth="1px" borderColor="border" py="5"><Text fontSize="13px" fontWeight="600">Start with a project</Text><Text fontSize="12px" color="fg.muted" mt="1">Paste a supported link or upload source media from Home, then configure generation before processing begins.</Text></Box></Stack>;
}
