"use client";

import { type ReactNode, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Flex, Heading, Stack, Text } from "@chakra-ui/react";
import { describeApiFailure, isApiErrorCode, sha256Hex } from "@narriflow/api-client";
import { acceptInviteMutation, inviteQuery } from "@narriflow/api-client/session";
import { MailX, UserRound } from "lucide-react";
import { Logo } from "@narriflow/ui/components/logo";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ApiProvider, useApiRuntime, useIdentityScope } from "@/app/_components/api-provider";
import { ApiErrorNotice, QueryLoadError } from "@/app/_components/query-mutation-form";
import { authEntryHref } from "@/lib/auth-entry";
import { formatDate } from "@/lib/format";

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
  onAccept,
  pending,
  error,
}: {
  workspaceName: string;
  role: string;
  /** The address the invitation was sent to. */
  email: string;
  expiresAt: Date | string;
  onAccept: () => void;
  pending: boolean;
  /** The failed acceptance, if any. */
  error: unknown;
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
        <Box>
          <Button size="lg" w="full" loading={pending} onClick={onAccept}>
            Accept invitation
          </Button>
          {error ? <ApiErrorNotice error={error} fallback="The invitation could not be accepted." /> : null}
        </Box>
        <Text fontSize="12px" color="fg.subtle">
          For {email} · expires {formatDate(expiresAt)}. Your personal workspace and its subscription stay separate.
        </Text>
      </Stack>
    </InviteShell>
  );
}

const SIGNED_OUT = { userId: "" };

function InviteContent({ token }: { token: string }) {
  const runtime = useApiRuntime();
  const router = useRouter();
  const identity = useIdentityScope();
  // The token is a credential: only its digest is part of the query key.
  const [digest, setDigest] = useState<string | null>(null);
  useEffect(() => {
    let current = true;
    void sha256Hex(token).then((value) => {
      if (current) setDigest(value);
    });
    return () => {
      current = false;
    };
  }, [token]);
  useEffect(() => {
    if (identity === null) router.replace(authEntryHref("sign-in", `/invite/${encodeURIComponent(token)}`));
  }, [identity, token, router]);

  const scope = identity ?? SIGNED_OUT;
  const preview = useQuery({
    ...inviteQuery(runtime.transport, scope, { token, digest: digest ?? "" }),
    enabled: identity !== null && digest !== null,
  });
  const accept = useMutation(acceptInviteMutation(runtime, scope));

  if (preview.isError) {
    const unavailable =
      isApiErrorCode(preview.error, "workspace_invite_invalid") || describeApiFailure(preview.error).kind === "missing";
    if (unavailable) return <InviteUnavailable />;
    return (
      <InviteShell>
        <QueryLoadError error={preview.error} what="This invitation" onRetry={() => void preview.refetch()} />
      </InviteShell>
    );
  }
  if (!preview.data) {
    return (
      <InviteShell>
        <Spinner />
        <Text role="status" fontSize="14px" color="fg.muted">Opening your invitation…</Text>
      </InviteShell>
    );
  }
  return (
    <InviteCard
      workspaceName={preview.data.workspaceName}
      role={preview.data.role}
      email={preview.data.email}
      expiresAt={preview.data.expiresAt}
      pending={accept.isPending}
      error={accept.error}
      // The mutation adopts the joined Workspace as the selection; the invitee then goes where the API says.
      onAccept={() => accept.mutate(token, { onSuccess: (accepted) => router.push(accepted.destination) })}
    />
  );
}

export function InviteScreen({ token }: { token: string }) {
  return (
    <ApiProvider fallback={<InviteShell><Spinner /></InviteShell>}>
      <InviteContent token={token} />
    </ApiProvider>
  );
}
