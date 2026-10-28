import Link from "next/link";
import { Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { ArrowLeft } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Logo } from "@narriflow/ui/components/logo";
import { Box } from "@chakra-ui/react";
import { ApiProvider } from "@/app/_components/api-provider";
import { CreateWorkspaceForm } from "./create-workspace-form";

/** Business workspace creation: the shell, the pitch in one line, then the form. */
export function NewWorkspaceScreen() {
  return (
    <Flex as="main" minH="100dvh" bg="bg.sidebar" direction="column">
      <Flex as="header" h="56px" flexShrink={0} align="center" px={{ base: "3", md: "5" }}>
        <Button variant="ghost" size="sm" asChild>
          <Link href="/home">
            <ArrowLeft size={14} aria-hidden />
            Back to Narriflow
          </Link>
        </Button>
      </Flex>
      <Flex flex="1" direction="column" align="center" justify="center" gap="6" px="4" pt="4" pb="16">
        <Logo size="md" />
        <Stack w="full" maxW="480px" gap="6" p={{ base: "6", sm: "8" }} bg="bg.panel" borderRadius="l3">
          <Stack gap="1.5">
            <Heading as="h1" textStyle="title" fontSize="24px">
              Create a Business workspace
            </Heading>
            <Text fontSize="14px" color="fg.muted">
              A shared space with its own projects, members, usage and subscription.
            </Text>
          </Stack>
          <ApiProvider fallback={<Box minH="64" />}>
            <CreateWorkspaceForm />
          </ApiProvider>
        </Stack>
      </Flex>
    </Flex>
  );
}
