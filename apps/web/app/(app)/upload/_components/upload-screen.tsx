"use client";

import { Box, Stack, Text } from "@chakra-ui/react";
import { describeApiFailure, type WorkspaceScope } from "@narriflow/api-client/core";
import { ingestConfigurationQueryOptions, linkResumeQueryOptions } from "@narriflow/api-client/ingest";
import { Button } from "@narriflow/ui/components/button";
import { useQuery } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { type ReactNode, useEffect, useState } from "react";
import { useApiRuntime, useWorkspaceScope } from "@/app/_components/api-provider";
import { IntakeProvider } from "../_lib/intake-context";
import { decideResume, decideResumeFailure, deniedImportDestination, type ResumeDecision } from "../_lib/resume-decision";
import { type SourcePickerConfig, sourcePickerConfig } from "../_lib/source-pickers";
import UploadLoading from "../loading";
import { UploadShell } from "./upload-shell";

/** Cloud pickers are configured by the deployment's public keys, which never leave web. */
const SOURCE_PICKERS: SourcePickerConfig = sourcePickerConfig({
  NEXT_PUBLIC_GOOGLE_API_KEY: process.env.NEXT_PUBLIC_GOOGLE_API_KEY,
  NEXT_PUBLIC_GOOGLE_CLIENT_ID: process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID,
  NEXT_PUBLIC_GOOGLE_APP_ID: process.env.NEXT_PUBLIC_GOOGLE_APP_ID,
  NEXT_PUBLIC_DROPBOX_APP_KEY: process.env.NEXT_PUBLIC_DROPBOX_APP_KEY,
});

/** What the link asked for, read once when the page opens. */
interface Entry {
  url: string | null;
  projectId: string | null;
  source: "auto" | "rss";
  mode: "clip" | "caption_only";
}

const FRESH_ENTRY: Entry = { url: null, projectId: null, source: "auto", mode: "clip" };

function readEntry(params: URLSearchParams): Entry {
  return {
    url: params.get("url"),
    projectId: params.get("project"),
    source: params.get("source") === "rss" ? "rss" : "auto",
    mode: params.get("mode") === "caption_only" ? "caption_only" : "clip",
  };
}

/**
 * Import for the selected Workspace: the configuration aggregate and, for
 * `?project=`, the Configure resume read run together; no server data.
 */
export function UploadScreen() {
  const scope = useWorkspaceScope();
  if (!scope) return <UploadLoading />;
  return <UploadContent key={scope.workspaceId} scope={scope} />;
}

function UploadContent({ scope }: { scope: WorkspaceScope }) {
  const { transport } = useApiRuntime();
  const router = useRouter();
  const params = useSearchParams();
  // The link is read once: Commit later rewrites it to `?project=`, which must not reload this page.
  const [openedWith] = useState(() => readEntry(params));
  const [decision, setDecision] = useState<ResumeDecision>(
    openedWith.projectId ? { kind: "pending" } : { kind: "fresh" },
  );
  // Nothing to resume starts over, as the old redirect to /upload did: the link's other settings go too.
  const entry = decision.kind === "restart" ? FRESH_ENTRY : openedWith;

  const configuration = useQuery(ingestConfigurationQueryOptions({ transport, scope }));
  const resume = useQuery({
    ...linkResumeQueryOptions({ transport, scope, projectId: openedWith.projectId ?? "" }),
    enabled: decision.kind === "pending",
  });

  // The first answer decides; later refetches (an accepted import invalidates the read) never move the page.
  useEffect(() => {
    if (decision.kind !== "pending" || !openedWith.projectId) return;
    if (resume.isFetching) return;
    if (resume.data) setDecision(decideResume(openedWith.projectId, resume.data));
    else if (resume.error) setDecision(decideResumeFailure(resume.error));
  }, [decision.kind, openedWith.projectId, resume.data, resume.error, resume.isFetching]);

  const denied = deniedImportDestination(configuration.error);
  useEffect(() => {
    if (denied) router.replace(denied);
  }, [denied, router]);

  useEffect(() => {
    if (decision.kind === "open_project") router.replace(`/projects/${decision.projectId}`);
    if (decision.kind === "restart") router.replace("/upload");
  }, [decision, router]);

  if (decision.kind === "workspace_mismatch") {
    return (
      <Notice
        title="This import belongs to another Workspace"
        body="Switch Workspaces to continue it, or start a new import here."
        action={
          <Button asChild size="sm" variant="subtle">
            <Link href="/upload">Start a new import</Link>
          </Button>
        }
      />
    );
  }
  if (denied) return <UploadLoading />;
  if (configuration.isError || decision.kind === "failed") {
    const failure = describeApiFailure(configuration.error ?? (decision.kind === "failed" ? decision.error : null));
    return (
      <Notice
        title="Import could not be loaded"
        body={
          failure.kind === "offline"
            ? "You appear to be offline. Check your connection and try again."
            : "Your upload options could not be loaded. Nothing has been changed."
        }
        action={
          <Button
            size="sm"
            variant="subtle"
            onClick={() => {
              void configuration.refetch();
              if (decision.kind === "failed") {
                setDecision({ kind: "pending" });
                void resume.refetch();
              }
            }}
          >
            Try again
          </Button>
        }
      />
    );
  }
  if (!configuration.data || decision.kind === "pending" || decision.kind === "open_project") {
    return <UploadLoading />;
  }

  const { brandTemplates, brandProfiles, usageSummary, recipes } = configuration.data;
  return (
    <IntakeProvider scope={scope}>
      <Stack gap={{ base: "6", md: "7" }} maxW="1080px" mx="auto">
        <Box animation="fade-up" style={{ animationDelay: "60ms" }} animationFillMode="backwards">
          <UploadShell
            recipes={recipes}
            brandTemplates={brandTemplates}
            brandProfiles={brandProfiles}
            initialUrl={entry.url}
            initialSource={entry.source}
            initialMode={entry.mode}
            resumeData={decision.kind === "resume" ? decision.data : null}
            usageSummary={usageSummary}
            sourcePickers={SOURCE_PICKERS}
          />
        </Box>
      </Stack>
    </IntakeProvider>
  );
}

function Notice({ title, body, action }: { title: string; body: string; action: ReactNode }) {
  return (
    <Stack gap="3" role="alert" align="flex-start" maxW="640px" mx="auto">
      <Text textStyle="title" fontSize="18px">
        {title}
      </Text>
      <Text fontSize="13px" color="fg.muted">
        {body}
      </Text>
      {action}
    </Stack>
  );
}
