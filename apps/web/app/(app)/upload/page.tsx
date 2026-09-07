import { redirect } from "next/navigation";
import { Box, Stack } from "@chakra-ui/react";
import { admitWorkspacePage } from "@/lib/authenticated-request-page";
import {
  brandProfileService,
  brandTemplateService,
  projectService,
} from "@narriflow/services";
import { parseStoredContentPack } from "@narriflow/validators";
import { UploadShell } from "./_components/upload-shell";
import type { LinkResumeData } from "./_components/link-import-flow";
import type { IngestStageStatus } from "./_lib/use-ingest-stream";

const RESUMABLE_INGEST_STATUSES: readonly IngestStageStatus[] = [
  "queued",
  "downloading",
  "normalizing",
  "ready",
  "failed",
];

function toIngestStageStatus(value: string): IngestStageStatus {
  return (RESUMABLE_INGEST_STATUSES as readonly string[]).includes(value)
    ? (value as IngestStageStatus)
    : "queued";
}

/**
 * Step-2 resume loader: validates ownership + "no existing run" (a run
 * already means Configure finished — nothing left to resume) and rehydrates
 * the draft ContentPack so refresh/back/return-later all pick up exactly
 * where Step 1 left off. Invalid or already-finalized resumes redirect
 * rather than rendering a broken Step 2.
 */
async function loadLinkResumeData(
  userId: string,
  projectId: string,
  workspaceId: string,
): Promise<LinkResumeData | null> {
  const snapshot = await projectService.getProjectSnapshot(
    userId,
    projectId,
    workspaceId,
  );

  if (!snapshot.project) {
    redirect("/upload");
  }
  if (snapshot.activeRun) {
    redirect(`/projects/${projectId}`);
  }
  if (
    snapshot.project.sourceType !== "youtube" &&
    snapshot.project.sourceType !== "link"
  ) {
    redirect("/upload");
  }

  const draftPack = await projectService.getLatestContentPack(projectId);
  if (!draftPack) {
    // queueLinkIngest always writes a draft pack atomically with the
    // project — reaching here means something upstream is broken. Nothing
    // sane to rehydrate; send the user back to start a fresh import.
    redirect("/upload");
  }

  return {
    projectId: snapshot.project.id,
    title: snapshot.project.title,
    sourceProvider: snapshot.project.sourceProvider,
    sourceMediaUrl: snapshot.project.sourceMediaUrl,
    languageCode: snapshot.project.languageCode,
    ingestStatus: toIngestStageStatus(snapshot.project.ingestStatus),
    ingestErrorCode: snapshot.project.ingestErrorCode,
    contentPack: parseStoredContentPack(draftPack),
  };
}

export default async function UploadPage({
  searchParams,
}: {
  searchParams: Promise<{
    url?: string | string[];
    project?: string | string[];
    source?: string;
    mode?: string;
  }>;
}) {
  const appUser = await admitWorkspacePage("processing.consume");
  const brandScope = {
    actorUserId: appUser.actorUserId,
    workspaceId: appUser.workspaceId,
    workspaceOwnerUserId: appUser.workspaceOwnerUserId,
    role: appUser.role,
    status: appUser.status,
    pricingTier: appUser.pricingTier,
    isPersonalWorkspace: appUser.isPersonalWorkspace,
  };
  const [
    brandTemplates,
    brandProfiles,
    defaultBrandProfileId,
    params,
    usageSummary,
  ] = await Promise.all([
    brandTemplateService.list(appUser.workspaceOwnerUserId, {
      workspaceId: appUser.workspaceId,
      actorUserId: appUser.actorUserId,
    }),
    brandProfileService.list(brandScope),
    brandProfileService.getDefaultId(brandScope),
    searchParams,
    projectService.getUsageSummary(
      appUser.workspaceOwnerUserId,
      appUser.workspaceId,
    ),
  ]);
  const rawUrl = Array.isArray(params.url) ? params.url[0] : params.url;
  const rawProjectId = Array.isArray(params.project)
    ? params.project[0]
    : params.project;

  const resumeData = rawProjectId
    ? await loadLinkResumeData(
        appUser.actorUserId,
        rawProjectId,
        appUser.workspaceId,
      )
    : null;

  return (
    <Stack gap={{ base: "6", md: "7" }} maxW="1080px" mx="auto">
      <Box
        animation="fade-up"
        style={{ animationDelay: "60ms" }}
        animationFillMode="backwards"
      >
        <UploadShell
          brandTemplates={brandTemplates}
          brandProfiles={{
            items: brandProfiles,
            defaultId: defaultBrandProfileId,
          }}
          initialUrl={rawUrl ?? null}
          initialSource={params.source === "rss" ? "rss" : "auto"}
          initialMode={params.mode === "caption_only" ? "caption_only" : "clip"}
          resumeData={resumeData}
          usageSummary={usageSummary}
        />
      </Box>
    </Stack>
  );
}
