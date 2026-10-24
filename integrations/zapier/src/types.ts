/** The parts of the REST API v1 responses this app reads. The OpenAPI document is the full contract. */

export interface ProjectView {
  projectId: string;
  title: string;
  sourceType: string;
  ingestStatus: string;
  durationSeconds: number | null;
  languageCode: string | null;
  createdAt: string;
  reviewUrl: string;
}

export interface ProjectResult {
  project: ProjectView;
}

export interface ProjectsResult {
  items: Array<ProjectView & { clipCount: number }>;
  nextCursor: string | null;
}

export interface ClipView {
  clipId: string;
  projectId: string;
  editorRevision: number;
  title: string | null;
  hookText: string;
  startSec: number;
  endSec: number;
  durationSec: number;
  scores: { virality: number };
  reviewUrl: string;
}

export interface ClipResult {
  clip: ClipView;
}

export interface ClipsResult {
  items: ClipView[];
  nextCursor: string | null;
}

export interface OperationView {
  operationId: string;
  kind: 'intake' | 'generation' | 'export';
  state: 'working' | 'completed' | 'partial' | 'failed' | 'cancelled';
  items: Array<{ kind: 'clip' | 'variant'; id: string; state: string; failureCode: string | null }>;
  results: { projectId: string | null; clipIds: string[]; exportId: string | null };
  failureCode: string | null;
  reviewUrl: string | null;
}

export interface AcceptedProject {
  projectId: string;
  operation: { operationId: string; kind: string; statusUrl: string };
  reviewUrl: string;
}

export interface BrandProfilesResult {
  profiles: Array<{ brandProfileId: string; name: string; isDefault: boolean }>;
}

export interface SocialAccountsResult {
  accounts: Array<{
    accountId: string;
    platform: string;
    displayName: string;
    handle: string | null;
    status: 'active' | 'expired' | 'revoked';
  }>;
  timeZone: string;
}

export interface CreatedExport {
  export: { exportId: string; projectId: string; clipId: string; editorRevision: number; status: string; reviewUrl: string };
  reused: boolean;
  output: { granted: { resolution: string; watermark: boolean }; reason: string | null };
  operation: { operationId: string; kind: string; statusUrl: string };
}

export interface ExportDownload {
  exportId: string;
  projectId: string;
  clipId: string;
  editorRevision: number;
  variants: Array<{
    variantId: string;
    aspectRatio: string;
    resolution: string;
    watermark: boolean;
    fileName: string;
    sizeBytes: number | null;
    downloadUrl: string;
    expiresAt: string;
  }>;
  subtitles: Array<{ format: 'srt' | 'vtt'; fileName: string; content: string }>;
}

export interface ProposedSocialPost {
  proposal: {
    proposalId: string;
    projectId: string;
    clipId: string;
    socialAccountId: string;
    platform: string;
    caption: string;
    source: string;
    exportId: string;
    exportVariantId: string;
    aspectRatio: string;
    createdAt: string;
  };
  queueUrl: string;
  replayed: boolean;
}

export const PLATFORM_LABELS: Record<string, string> = {
  tiktok: 'TikTok',
  youtube_shorts: 'YouTube Shorts',
  instagram_reels: 'Instagram Reels',
  facebook_reels: 'Facebook Reels',
  linkedin: 'LinkedIn',
  x: 'X',
};
