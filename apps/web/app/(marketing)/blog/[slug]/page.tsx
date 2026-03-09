import { Box, Heading, Text, VStack } from "@chakra-ui/react";

export default async function BlogPostPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  return (
    <VStack as="main" mx="auto" w="full" maxW="720px" px="6" py="80px" gap="16px" align="start">
      <Heading
        fontSize={{ base: "28px", md: "36px" }}
        fontWeight="700"
        letterSpacing="-0.03em"
      >
        {slug.replace(/-/g, " ")}
      </Heading>
      <Text fontSize="15px" color="fg.muted">
        CMS integration placeholder for marketing content.
      </Text>
    </VStack>
  );
}
