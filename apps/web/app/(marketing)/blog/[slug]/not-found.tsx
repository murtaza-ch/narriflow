import Link from "next/link";
import { Box, Stack } from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { PageHeader } from "@narriflow/ui/components/page-header";
import { FileText } from "lucide-react";

export default function BlogPostNotFound() {
  return (
    <Stack as="main" mx="auto" w="full" maxW="760px" px="6" pt={{ base: "14", md: "20" }} pb="24" gap="6">
      <PageHeader eyebrow="Blog" title="Post not found" />
      <Box>
        <EmptyState
          icon={<FileText size={22} strokeWidth={1.5} />}
          title="Nothing published here yet"
          description="This post doesn't exist — or hasn't been written. The product, meanwhile, is very much live."
          action={
            <Button asChild variant="outline" size="sm">
              <Link href="/">Back to the homepage</Link>
            </Button>
          }
        />
      </Box>
    </Stack>
  );
}
