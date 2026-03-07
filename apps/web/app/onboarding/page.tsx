import { redirect } from "next/navigation";
import { Button } from "@narriflow/ui/components/button";
import { getCurrentAppUser } from "@narriflow/auth";
import { completeOnboardingAction } from "../actions/onboarding";
import { VStack, Stack, Box, Heading, Text } from "@chakra-ui/react";

export default async function OnboardingPage() {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    redirect("/sign-in");
  }

  if (appUser.onboardingCompletedAt) {
    redirect("/dashboard");
  }

  return (
    <VStack as="main" mx="auto" minH="100vh" w="full" maxW="2xl" justify="center" gap="8" px="6" py="16" align="stretch">
      <Stack gap="3">
        <Heading size="2xl" fontWeight="semibold" letterSpacing="tight">Finish onboarding</Heading>
        <Text color="fg.muted">
          Your workspace is ready. Complete onboarding to unlock project creation and workflow generation.
        </Text>
      </Stack>

      <Box as="section" rounded="xl" borderWidth="1px" borderColor="border" p="6">
        <Heading as="h2" size="lg" fontWeight="semibold">What happens next</Heading>
        <Stack as="ul" mt="3" listStyleType="disc" gap="2" pl="5" textStyle="sm" color="fg.muted">
          <Box as="li">Your account is linked to your workspace and usage tracking.</Box>
          <Box as="li">New projects are scoped securely to your user identity.</Box>
          <Box as="li">Generation APIs enforce authenticated ownership checks.</Box>
        </Stack>

        <form action={completeOnboardingAction}>
          <Box mt="6">
            <Button type="submit">Complete Onboarding</Button>
          </Box>
        </form>
      </Box>
    </VStack>
  );
}
