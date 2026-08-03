"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type {
  BrandTemplateSummary,
  ContentPack,
  GenerationMode,
  LinkProviderId,
} from "@narriflow/validators";
import {
  DEFAULT_LINK_CONFIGURE_STATE,
  type LinkConfigureState,
} from "../_lib/link-content-pack";
import type { IngestStageStatus } from "../_lib/use-ingest-stream";
import { CommitStep, type CommitStepResult } from "./commit-step";
import { ConfigureStep } from "./configure-step";

export interface LinkResumeData {
  projectId: string;
  title: string;
  sourceProvider: string | null;
  sourceMediaUrl: string;
  languageCode: string | null;
  ingestStatus: IngestStageStatus;
  ingestErrorCode: string | null;
  contentPack: ContentPack;
}

export interface UploadUsageSummary {
  tier: string;
  usedMinutes: number;
  limitMinutes: number;
  maxUploadSeconds: number;
}

interface LinkImportFlowProps {
  linkUrl: string;
  linkProvider: LinkProviderId;
  brandTemplates: {
    builtIns: BrandTemplateSummary[];
    mine: BrandTemplateSummary[];
    defaultId: string | null;
  };
  usageSummary: UploadUsageSummary;
  /** Present when the page mounted with `?project=<id>` — skips Step 1
   *  entirely and rehydrates Step 2 from the server-loaded draft. */
  resumeData: LinkResumeData | null;
  onChangeSource: () => void;
}

function step2StateFromContentPack(contentPack: ContentPack): LinkConfigureState {
  return {
    mode: contentPack.mode,
    clipLengthPreset: contentPack.clipLengthPreset,
    captionPreset: contentPack.captionPreset,
    defaultAspectRatio: contentPack.defaultAspectRatio,
    autoHook: contentPack.autoHook,
    autoRenderClips: contentPack.autoRenderClips,
    specificMoments: contentPack.specificMoments,
    platformTargets: contentPack.platformTargets,
    clipCountTarget: contentPack.clipCountTarget,
    toneConstraints: contentPack.toneConstraints.join(", "),
    processingStartSec: contentPack.processingStartSec,
    processingEndSec: contentPack.processingEndSec,
  };
}

/**
 * Link-first Commit → Configure state machine (Phase 1 of the link-to-clips
 * plan). Owns all state for the link path independent of the shared
 * upload-shell state used by the untouched file/RSS flows.
 */
export function LinkImportFlow({
  linkUrl,
  linkProvider,
  brandTemplates,
  usageSummary,
  resumeData,
  onChangeSource,
}: LinkImportFlowProps) {
  const router = useRouter();
  const [step, setStep] = useState<"commit" | "configure">(
    resumeData ? "configure" : "commit",
  );
  const [projectId, setProjectId] = useState<string | null>(
    resumeData?.projectId ?? null,
  );
  const [title, setTitle] = useState(resumeData?.title ?? "");
  const [languageCode, setLanguageCode] = useState(resumeData?.languageCode ?? "auto");
  const [mode, setMode] = useState<GenerationMode>(resumeData?.contentPack.mode ?? "clip");
  const [step2State, setStep2State] = useState<LinkConfigureState>(() =>
    resumeData
      ? step2StateFromContentPack(resumeData.contentPack)
      : {
          ...DEFAULT_LINK_CONFIGURE_STATE,
          mode: "clip",
          processingStartSec: null,
          processingEndSec: null,
        },
  );
  const [ingestStatus, setIngestStatus] = useState<IngestStageStatus>(
    resumeData?.ingestStatus ?? "queued",
  );
  const [ingestErrorCode, setIngestErrorCode] = useState<string | null>(
    resumeData?.ingestErrorCode ?? null,
  );
  const [sourceMediaUrl, setSourceMediaUrl] = useState(
    resumeData?.sourceMediaUrl ?? linkUrl,
  );
  const [sourceProvider, setSourceProvider] = useState<string | null>(
    resumeData?.sourceProvider ?? linkProvider,
  );

  // Minted once per Step-1 render, never regenerated across re-renders of
  // this component — a resumed (Step-2) mount never needs one at all.
  const commitTokenRef = useRef<string>("");
  if (!commitTokenRef.current && !resumeData) {
    commitTokenRef.current = crypto.randomUUID();
  }

  function handleCommitted(result: CommitStepResult) {
    setProjectId(result.projectId);
    setTitle(result.title);
    setLanguageCode(result.languageCode);
    setMode(result.mode);
    setStep2State((current) => ({
      ...current,
      mode: result.mode,
      processingStartSec: result.processingStartSec,
      processingEndSec: result.processingEndSec,
    }));
    setSourceMediaUrl(linkUrl);
    setSourceProvider(linkProvider);
    setIngestStatus("queued");
    setIngestErrorCode(null);
    setStep("configure");
    router.replace(`/upload?project=${result.projectId}`, { scroll: false });
  }

  if (step === "commit" || !projectId) {
    return (
      <CommitStep
        linkUrl={linkUrl}
        linkProvider={linkProvider}
        brandTemplates={brandTemplates}
        usageSummary={usageSummary}
        commitToken={commitTokenRef.current}
        onCommitted={handleCommitted}
        onChangeSource={onChangeSource}
      />
    );
  }

  return (
    <ConfigureStep
      projectId={projectId}
      title={title}
      sourceProvider={sourceProvider}
      sourceMediaUrl={sourceMediaUrl}
      initialIngestStatus={ingestStatus}
      initialIngestErrorCode={ingestErrorCode}
      mode={mode}
      languageCode={languageCode}
      initialStep2={step2State}
    />
  );
}
