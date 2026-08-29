import { redirect } from "next/navigation";
import { Stack, Box, Text, Flex } from "@chakra-ui/react";
import { Shield, FolderOpen, Zap } from "lucide-react";
import { admitSignedInPage } from "@/lib/authenticated-request-page";
import { AuthShell, AuthHeader } from "../components/auth-shell";
import { OnboardingForm } from "./onboarding-form";

const SETUP_ITEMS = [
  {
    icon: <FolderOpen size={15} strokeWidth={1.75} />,
    title: "Project workspace",
    desc: "Projects are scoped to your account",
  },
  {
    icon: <Shield size={15} strokeWidth={1.75} />,
    title: "Secure by default",
    desc: "Authenticated ownership on all APIs",
  },
  {
    icon: <Zap size={15} strokeWidth={1.75} />,
    title: "AI workflows",
    desc: "Transcription and clip generation ready",
  },
];

export default async function OnboardingPage() {
  const appUser = await admitSignedInPage("/onboarding");

  if (appUser.onboardingCompletedAt) {
    redirect("/home");
  }

  return (
    <AuthShell
      maxW="420px"
      footer={
        <Text
          textStyle="eyebrow"
          color="fg.subtle"
          animation="fade-up"
          animationDelay="160ms"
          animationFillMode="backwards"
        >
          Long video in · Short clips out
        </Text>
      }
    >
      <Stack gap="7">
        <AuthHeader
          eyebrow="First run"
          title={appUser.firstName ? `Welcome, ${appUser.firstName}` : "Welcome to Narriflow"}
          description="Your workspace is ready. Tell us who's publishing."
        />

        <OnboardingForm
          defaultFirstName={appUser.firstName ?? ""}
          defaultLastName={appUser.lastName ?? ""}
        />

        {/* What's already set up — a drawn band of hairline rows, not boxes */}
        <Box layerStyle="band">
          <Text textStyle="eyebrow" color="fg.subtle">
            Ready for you
          </Text>
          <Stack gap="0" pt="1">
            {SETUP_ITEMS.map((item, index) => (
              <Flex
                key={item.title}
                gap="3"
                align="center"
                py="2.5"
                borderTopWidth={index === 0 ? "0" : "1px"}
                borderColor="border.subtle"
              >
                <Flex color="fg.muted" flexShrink={0} aria-hidden="true">
                  {item.icon}
                </Flex>
                <Box>
                  <Text fontSize="13px" fontWeight="500" color="fg">
                    {item.title}
                  </Text>
                  <Text fontSize="12px" color="fg.muted">
                    {item.desc}
                  </Text>
                </Box>
              </Flex>
            ))}
          </Stack>
        </Box>
      </Stack>
    </AuthShell>
  );
}
