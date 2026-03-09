import { redirect } from "next/navigation";
import Link from "next/link";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { getCurrentAppUser } from "@narriflow/auth";
import { completeOnboardingAction } from "../actions/onboarding";
import { VStack, Stack, Box, Heading, Text, Flex } from "@chakra-ui/react";
import { Shield, FolderOpen, Zap } from "lucide-react";

export default async function OnboardingPage() {
  const appUser = await getCurrentAppUser();

  if (!appUser) {
    redirect("/sign-in");
  }

  if (appUser.onboardingCompletedAt) {
    redirect("/dashboard");
  }

  return (
    <Flex as="main" minH="100vh" align="center" justify="center" bg="bg" px="6" py="10" color="fg">
      <Stack gap="24px" align="center" w="full" maxW="400px">
        <Link href="/">
          <Logo size="lg" />
        </Link>

        <Stack
          w="full"
          gap="24px"
          borderRadius="16px"
          borderWidth="1px"
          borderColor="border"
          bg="bg.panel"
          p="32px"
          shadow="md"
        >
          <Stack gap="4px" textAlign="center">
            <Heading size="lg" fontWeight="600" letterSpacing="-0.02em">
              Welcome to Narriflow
            </Heading>
            <Text fontSize="13px" color="fg.muted">
              Your workspace is ready. Here's what's set up for you.
            </Text>
          </Stack>

          <Stack gap="12px">
            {[
              { icon: <FolderOpen size={18} />, title: "Project workspace", desc: "Projects are scoped to your account" },
              { icon: <Shield size={18} />, title: "Secure by default", desc: "Authenticated ownership on all APIs" },
              { icon: <Zap size={18} />, title: "AI workflows", desc: "Transcription and clip generation ready" },
            ].map((item) => (
              <Flex key={item.title} gap="12px" align="start">
                <Flex
                  w="36px"
                  h="36px"
                  borderRadius="8px"
                  bg="bg.muted"
                  align="center"
                  justify="center"
                  color="fg.muted"
                  flexShrink={0}
                >
                  {item.icon}
                </Flex>
                <Box>
                  <Text fontSize="13px" fontWeight="500" color="fg">{item.title}</Text>
                  <Text fontSize="12px" color="fg.muted">{item.desc}</Text>
                </Box>
              </Flex>
            ))}
          </Stack>

          <form action={completeOnboardingAction}>
            <Button type="submit" w="full">
              Complete Setup
            </Button>
          </form>
        </Stack>
      </Stack>
    </Flex>
  );
}
