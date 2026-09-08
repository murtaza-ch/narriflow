import { SimpleGrid, Skeleton, Stack } from "@chakra-ui/react";

export default function Loading() {
  return <Stack gap="8" aria-busy="true" aria-label="Loading social accounts">
    <Skeleton h="8" w="56" maxW="full" />
    <Stack gap="3"><Skeleton h="4" w="64" maxW="full" /><Skeleton h="3" w="full" maxW="560px" /></Stack>
    <SimpleGrid columns={{ base: 1, sm: 2, md: 3 }} gap="3" maxW="600px" css={{ "@media (min-width: 360px) and (max-width: 479px)": { gridTemplateColumns: "repeat(2, minmax(0, 1fr))" } }}>
      {[0, 1, 2, 3, 4, 5].map((index) => <Skeleton key={index} h="132px" borderRadius="l2" />)}
    </SimpleGrid>
  </Stack>;
}
