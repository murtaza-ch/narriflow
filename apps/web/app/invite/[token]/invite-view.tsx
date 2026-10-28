import type { ReactNode } from "react";
import Link from "next/link";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { MailX, UserRound } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { Button } from "@narriflow/ui/components/button";
import { formatDate } from "@/lib/format";
import { AuthenticatedActionForm } from "@/app/_components/authenticated-action-form";

/** What each role can do, matching the workspace capability table. */
const ROLE_COPY: Record<string, string> = {
  admin: "Create and edit content, manage the workspace and invite members.",
  editor: "Create, edit and publish clips.",
  viewer: "Watch and download clips.",
};

function initialsOf(name: string) {
  const letters = name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => Array.from(part)[0] ?? "");
  return letters.join("").toUpperCase() || "W";
}

function InviteShell({ children }: { children: ReactNode }) {
  return (
    <Flex as="main" minH="100dvh" bg="bg.sidebar" direction="column" align="center" justify="center" gap="6" px="4" py="10">
      <Logo size="md" />
      <Stack w="full" maxW="440px" align="center" textAlign="center" gap="6" p={{ base: "6", sm: "8" }} bg="bg.panel" borderRadius="l3">
        {children}
      </Stack>
    </Flex>
  );
}

/** The link is expired, revoked, or already used. */
export function InviteUnavailable() {
  return (
    <InviteShell>
      <Flex boxSize="12" align="center" justify="center" borderRadius="full" bg="bg.soft" color="fg.muted" aria-hidden>
        <MailX size={20} />
      </Flex>
      <Stack gap="1.5">
        <Heading as="h1" textStyle="title" fontSize="22px">
          Invitation unavailable
        </Heading>
        <Text fontSize="14px" color="fg.muted">
          This link has expired, was revoked, or was already accepted. Ask the workspace admin for a new one.
        </Text>
      </Stack>
      <Button asChild variant="subtle">
        <Link href="/home">Go to Narriflow</Link>
      </Button>
    </InviteShell>
  );
}

export function InviteCard({
  workspaceName,
  role,
  email,
  expiresAt,
  action,
}: {
  workspaceName: string;
  role: string;
  /** The address the invitation was sent to. */
  email: string;
  expiresAt: Date | string;
  action: (formData: FormData) => Promise<unknown>;
}) {
  return (
    <InviteShell>
      <Flex boxSize="16" align="center" justify="center" borderRadius="l2" bg="bg.soft" fontSize="22px" fontWeight="500" aria-hidden>
        {initialsOf(workspaceName)}
      </Flex>
      <Stack gap="1.5">
        <Text fontSize="13px" color="fg.muted">
          You&apos;re invited to join
        </Text>
        <Heading as="h1" textStyle="title" fontSize="28px" overflowWrap="anywhere">
          {workspaceName}
        </Heading>
      </Stack>
      <Stack w="full" gap="1" p="4" bg="bg.soft" borderRadius="l2" textAlign="start">
        <Flex align="center" gap="2">
          <Box color="fg.muted">
            <UserRound size={15} aria-hidden />
          </Box>
          <Text fontSize="14px" fontWeight="500" textTransform="capitalize">
            {role}
          </Text>
        </Flex>
        {ROLE_COPY[role] ? (
          <Text fontSize="13px" color="fg.muted">
            {ROLE_COPY[role]}
          </Text>
        ) : null}
      </Stack>
      <Stack w="full" gap="3">
        <AuthenticatedActionForm action={action}>
          <Button type="submit" size="lg" w="full">
            Accept invitation
          </Button>
        </AuthenticatedActionForm>
        <Text fontSize="12px" color="fg.subtle">
          For {email} · expires {formatDate(expiresAt)}. Your personal workspace and its subscription stay separate.
        </Text>
      </Stack>
    </InviteShell>
  );
}
