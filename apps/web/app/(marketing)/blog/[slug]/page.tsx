import { Box, Heading, Text } from "@chakra-ui/react";

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <Box as="main" mx="auto" w="full" maxW="3xl" px="6" py="16">
      <Heading size="xl" fontWeight="semibold" letterSpacing="tight">
        Blog: {slug}
      </Heading>
      <Text mt="3" color="fg.muted">
        CMS integration placeholder for marketing content.
      </Text>
    </Box>
  );
}
