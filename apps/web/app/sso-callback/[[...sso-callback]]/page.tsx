import { AuthenticateWithRedirectCallback } from "@clerk/nextjs";
import { Box, Flex, Text } from "@chakra-ui/react";

export default function SSOCallbackPage() {
  return (
    <Flex minH="100vh" w="full" align="center" justify="center" bg="bg" color="fg" px="6" py="10">
      <Box
        w="full"
        maxW="400px"
        borderWidth="1px"
        borderColor="border"
        borderRadius="16px"
        bg="bg.panel"
        p="32px"
        shadow="md"
        textAlign="center"
      >
        <Text fontSize="13px" color="fg.muted" mb="16px">Completing sign in...</Text>
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
