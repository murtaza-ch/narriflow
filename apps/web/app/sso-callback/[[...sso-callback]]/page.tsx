import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { Box, Flex } from "@chakra-ui/react";

export default function SSOCallbackPage() {
  return (
    <Flex minH="100vh" w="full" maxW="md" mx="auto" align="center" justify="center" px="6" py="10">
      <Box w="full" borderWidth="1px" borderColor="border" rounded="xl" bg="bg.panel" p="6">
        <AuthenticateWithRedirectCallback
          continueSignUpUrl="/sign-up/continue"
          signInFallbackRedirectUrl="/onboarding"
          signInUrl="/sign-in"
          signUpFallbackRedirectUrl="/onboarding"
        />
        <Box id="clerk-captcha" />
      </Box>
    </Flex>
  );
}
