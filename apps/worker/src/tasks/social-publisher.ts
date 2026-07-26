import { createHmac } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  downloadObjectToFile,
  presignDownloadUrl,
  socialOAuthService,
  SocialOAuthError,
  socialService,
  type PublishSocialAccount,
} from "@narriflow/services";
import {
  clipAspectRatioDbSchema,
  clipAspectRatioFromDb,
  socialPostMetricsSchema,
  type ClipAspectRatio,
  type SocialPostMetricsInput,
} from "@narriflow/validators";

type ClaimedSocialPost = Awaited<ReturnType<typeof socialService.claimDuePosts>>[number];

type MediaPayload = {
  type: "video/mp4";
  downloadUrl: string;
  expiresInSeconds: number;
  fileName: string;
  aspectRatio: ClipAspectRatio;
  clipId: string;
  storageKey: string;
};

type LocalMediaPayload = MediaPayload & {
  localPath: string;
  sizeBytes: number;
  cleanup: () => Promise<void>;
};

type PublishResult = {
  externalUrl: string | null;
  metrics: SocialPostMetricsInput | null;
  metadata?: Record<string, unknown>;
};

class SocialPublisherError extends Error {
  code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function log(
  level: "info" | "error",
  message: string,
  context?: Record<string, unknown>,
) {
  console.log(
    JSON.stringify({
      level,
      message,
      ts: new Date().toISOString(),
      ...context,
    }),
  );
}

function getPublisherWebhookUrl() {
  return process.env.SOCIAL_PUBLISH_WEBHOOK_URL?.trim() || null;
}

function signPayload(payload: string) {
  const secret = process.env.SOCIAL_PUBLISH_WEBHOOK_SECRET?.trim();
  if (!secret) return null;
  return `sha256=${createHmac("sha256", secret).update(payload).digest("hex")}`;
}

function aspectRatioFromDb(value: unknown): ClipAspectRatio {
  return clipAspectRatioFromDb[clipAspectRatioDbSchema.parse(value)];
}

function postMetadata(post: ClaimedSocialPost): Record<string, unknown> {
  return post.metadata && typeof post.metadata === "object" && !Array.isArray(post.metadata)
    ? (post.metadata as Record<string, unknown>)
    : {};
}

function metadataString(
  metadata: Record<string, unknown>,
  keys: string[],
  fallback: string | null = null,
) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return fallback;
}

function metadataBoolean(
  metadata: Record<string, unknown>,
  keys: string[],
  fallback = false,
) {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === "boolean") return value;
  }
  return fallback;
}

function truncate(value: string, maxLength: number) {
  return value.length <= maxLength ? value : value.slice(0, maxLength - 1).trimEnd();
}

function titleFromCaption(caption: string) {
  return truncate(caption.split(/\r?\n/)[0]?.trim() || "Narriflow clip", 95);
}

function wait(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Applies ±20% jitter (90%–110%) so concurrent workers don't poll a provider
 *  in lockstep. Runtime code, so Math.random() is fine here. */
function jitter(ms: number): number {
  return Math.round(ms * (0.9 + Math.random() * 0.2));
}

async function readJsonResponse(response: Response, errorCode: string) {
  const body = await response.text();
  let parsed: unknown = null;
  if (body) {
    try {
      parsed = JSON.parse(body);
    } catch {
      parsed = body;
    }
  }
  if (!response.ok) {
    throw new SocialPublisherError(
      errorCode,
      `Social provider request failed with ${response.status}: ${body.slice(0, 500)}`,
    );
  }
  return parsed;
}

async function fetchJson(
  url: string,
  init: RequestInit,
  errorCode = "social_provider_failed",
) {
  return readJsonResponse(await fetch(url, init), errorCode);
}

async function buildMediaPayload(post: ClaimedSocialPost): Promise<MediaPayload | null> {
  if (!post.clipId || !post.clip) return null;

  const requestedAspectRatio = post.aspectRatio
    ? clipAspectRatioDbSchema.parse(post.aspectRatio)
    : null;
  const render =
    post.clip.renders.find(
      (candidate) =>
        candidate.status === "completed" &&
        Boolean(candidate.storageKey) &&
        (!requestedAspectRatio || candidate.aspectRatio === requestedAspectRatio),
    ) ??
    post.clip.renders.find(
      (candidate) => candidate.status === "completed" && Boolean(candidate.storageKey),
    );

  if (!render?.storageKey) {
    throw new SocialPublisherError(
      "social_asset_missing",
      "Scheduled post references a clip without a completed render",
    );
  }

  const aspectRatio = aspectRatioFromDb(render.aspectRatio);
  const fileName = `social-${post.platform}-clip-${post.clip.index + 1}-${aspectRatio.replace(":", "x")}.mp4`;
  const downloadUrl = await presignDownloadUrl({
    key: render.storageKey,
    fileName,
    expiresIn: 7200,
  });

  return {
    type: "video/mp4" as const,
    downloadUrl,
    expiresInSeconds: 7200,
    fileName,
    aspectRatio,
    clipId: post.clipId,
    storageKey: render.storageKey,
  };
}

async function downloadMedia(media: MediaPayload): Promise<LocalMediaPayload> {
  const dir = await mkdtemp(join(tmpdir(), "narriflow-social-"));
  const localPath = join(dir, media.fileName);
  await downloadObjectToFile({ key: media.storageKey, filePath: localPath });
  const stats = await stat(localPath);
  return {
    ...media,
    localPath,
    sizeBytes: stats.size,
    cleanup: async () => {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

async function deliverPost(
  webhookUrl: string,
  post: ClaimedSocialPost,
): Promise<PublishResult> {
  const media = await buildMediaPayload(post);
  const body = JSON.stringify({
    event: "social.post.publish",
    postId: post.id,
    projectId: post.projectId,
    projectTitle: post.project.title,
    platform: post.platform,
    caption: post.caption,
    scheduledFor: post.scheduledFor?.toISOString() ?? null,
    metadata: post.metadata ?? null,
    media,
  });

  const signature = signPayload(body);
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "User-Agent": "Narriflow-SocialPublisher/1.0",
  };
  if (signature) {
    headers["X-Narriflow-Signature"] = signature;
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers,
    body,
  });
  const responseBody = await response.text().catch(() => "");

  if (!response.ok) {
    throw new SocialPublisherError(
      "social_webhook_failed",
      `Publisher webhook failed with status ${response.status}: ${responseBody.slice(0, 300)}`,
    );
  }

  let externalUrl: string | null = null;
  let metrics: SocialPostMetricsInput | null = null;
  try {
    const parsed = JSON.parse(responseBody) as {
      externalUrl?: unknown;
      url?: unknown;
      metrics?: unknown;
    };
    externalUrl =
      typeof parsed.externalUrl === "string"
        ? parsed.externalUrl
        : typeof parsed.url === "string"
          ? parsed.url
          : null;
    const metricsParsed = socialPostMetricsSchema.safeParse(parsed.metrics);
    metrics = metricsParsed.success ? metricsParsed.data : null;
  } catch {
    externalUrl = null;
    metrics = null;
  }

  return { externalUrl, metrics };
}

function requireMedia(media: MediaPayload | null): MediaPayload {
  if (!media) {
    throw new SocialPublisherError(
      "social_asset_missing",
      "Scheduled post does not reference a rendered clip",
    );
  }
  return media;
}

function getAccountMetadata(account: PublishSocialAccount) {
  return account.metadata && typeof account.metadata === "object" && !Array.isArray(account.metadata)
    ? (account.metadata as Record<string, unknown>)
    : {};
}

async function publishNativePost(post: ClaimedSocialPost): Promise<PublishResult> {
  if (!post.socialAccountId || !post.socialAccount) {
    throw new SocialPublisherError(
      "social_account_missing",
      "Scheduled post does not reference a connected social account",
    );
  }

  const media = requireMedia(await buildMediaPayload(post));
  const account = await socialOAuthService.getPublishAccount(post.socialAccountId);
  if (account.platform !== post.platform) {
    throw new SocialPublisherError(
      "social_account_platform_mismatch",
      "Connected account platform does not match scheduled post platform",
    );
  }

  switch (post.platform) {
    case "tiktok":
      return publishTikTok(account, post, await downloadMedia(media));
    case "youtube_shorts":
      return publishYouTube(account, post, await downloadMedia(media));
    case "instagram_reels":
      return publishInstagram(account, post, media);
    case "linkedin":
      return publishLinkedIn(account, post, await downloadMedia(media));
    case "x":
      return publishX(account, post, await downloadMedia(media));
    default:
      throw new SocialPublisherError("social_platform_unsupported", "Unsupported social platform");
  }
}

async function publishYouTube(
  account: PublishSocialAccount,
  post: ClaimedSocialPost,
  media: LocalMediaPayload,
): Promise<PublishResult> {
  try {
    const metadata = postMetadata(post);
    const privacyStatus = metadataString(metadata, ["youtubePrivacyStatus", "privacyStatus"], "public");
    const videoMetadata = {
      snippet: {
        title: metadataString(metadata, ["title"], titleFromCaption(post.caption)),
        description: post.caption,
        categoryId: metadataString(metadata, ["youtubeCategoryId"], "22"),
      },
      status: {
        privacyStatus,
        selfDeclaredMadeForKids: metadataBoolean(metadata, ["selfDeclaredMadeForKids"], false),
      },
    };

    const initResponse = await fetch(
      "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
          "X-Upload-Content-Type": "video/mp4",
          "X-Upload-Content-Length": String(media.sizeBytes),
        },
        body: JSON.stringify(videoMetadata),
      },
    );
    const uploadUrl = initResponse.headers.get("location");
    if (!initResponse.ok || !uploadUrl) {
      await readJsonResponse(initResponse, "youtube_upload_init_failed");
      throw new SocialPublisherError("youtube_upload_init_failed", "YouTube did not return an upload URL");
    }

    const file = await readFile(media.localPath);
    const uploadResult = await fetchJson(
      uploadUrl,
      {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(media.sizeBytes),
        },
        body: file,
      },
      "youtube_upload_failed",
    ) as { id?: string };

    if (!uploadResult.id) {
      throw new SocialPublisherError("youtube_video_id_missing", "YouTube upload response did not include a video id");
    }

    return {
      externalUrl: `https://www.youtube.com/watch?v=${uploadResult.id}`,
      metrics: null,
      metadata: {
        provider: "youtube",
        platformPostId: uploadResult.id,
      },
    };
  } finally {
    await media.cleanup();
  }
}

async function publishInstagram(
  account: PublishSocialAccount,
  post: ClaimedSocialPost,
  media: MediaPayload,
): Promise<PublishResult> {
  const metadata = postMetadata(post);
  const accountMetadata = getAccountMetadata(account);
  const igUserId = metadataString(accountMetadata, ["igUserId"], account.providerAccountId);
  const search = new URLSearchParams({
    media_type: "REELS",
    video_url: media.downloadUrl,
    caption: post.caption,
    share_to_feed: String(metadataBoolean(metadata, ["shareToFeed"], true)),
    access_token: account.accessToken,
  });

  const container = await fetchJson(
    `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v20.0"}/${igUserId}/media`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: search,
    },
    "instagram_container_create_failed",
  ) as { id?: string };

  if (!container.id) {
    throw new SocialPublisherError(
      "instagram_container_missing",
      "Instagram did not return a media container id",
    );
  }

  await pollInstagramContainer(account.accessToken, container.id);

  const published = await fetchJson(
    `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v20.0"}/${igUserId}/media_publish`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        creation_id: container.id,
        access_token: account.accessToken,
      }),
    },
    "instagram_publish_failed",
  ) as { id?: string };

  if (!published.id) {
    throw new SocialPublisherError("instagram_media_id_missing", "Instagram publish response did not include a media id");
  }

  let permalink: string | null = null;
  try {
    const details = await fetchJson(
      `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v20.0"}/${published.id}?` +
        new URLSearchParams({
          fields: "permalink",
          access_token: account.accessToken,
        }),
      { method: "GET" },
      "instagram_permalink_failed",
    ) as { permalink?: string };
    permalink = details.permalink ?? null;
  } catch {
    permalink = null;
  }

  return {
    externalUrl: permalink,
    metrics: null,
    metadata: {
      provider: "instagram",
      platformPostId: published.id,
      creationId: container.id,
    },
  };
}

async function pollInstagramContainer(accessToken: string, containerId: string) {
  const attempts = Number(process.env.INSTAGRAM_CONTAINER_POLL_ATTEMPTS ?? "30");
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const status = await fetchJson(
      `https://graph.facebook.com/${process.env.META_GRAPH_VERSION?.trim() || "v20.0"}/${containerId}?` +
        new URLSearchParams({
          fields: "status_code,status",
          access_token: accessToken,
        }),
      { method: "GET" },
      "instagram_container_status_failed",
    ) as { status_code?: string; status?: string };

    if (status.status_code === "FINISHED") return;
    if (status.status_code === "ERROR") {
      throw new SocialPublisherError(
        "instagram_container_processing_failed",
        status.status || "Instagram media container processing failed",
      );
    }
    await wait(jitter(Number(process.env.INSTAGRAM_CONTAINER_POLL_INTERVAL_MS ?? "5000")));
  }

  throw new SocialPublisherError(
    "instagram_container_processing_timeout",
    "Instagram media container was not ready before the worker timeout",
  );
}

async function publishTikTok(
  account: PublishSocialAccount,
  post: ClaimedSocialPost,
  media: LocalMediaPayload,
): Promise<PublishResult> {
  try {
    const metadata = postMetadata(post);
    const creator = await fetchJson(
      "https://open.tiktokapis.com/v2/post/publish/creator_info/query/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
      },
      "tiktok_creator_info_failed",
    ) as {
      data?: {
        creator_username?: string;
        privacy_level_options?: string[];
        comment_disabled?: boolean;
        duet_disabled?: boolean;
        stitch_disabled?: boolean;
      };
    };
    const privacyOptions = creator.data?.privacy_level_options ?? [];
    const requestedPrivacy = metadataString(metadata, ["tiktokPrivacyLevel", "privacyLevel"]);
    const privacyLevel =
      requestedPrivacy && privacyOptions.includes(requestedPrivacy)
        ? requestedPrivacy
        : privacyOptions.includes("PUBLIC_TO_EVERYONE")
          ? "PUBLIC_TO_EVERYONE"
          : privacyOptions[0] ?? "SELF_ONLY";

    const chunkSize = Math.min(
      media.sizeBytes,
      Number(process.env.TIKTOK_UPLOAD_CHUNK_BYTES ?? String(64 * 1024 * 1024)),
    );
    const totalChunkCount = Math.max(1, Math.ceil(media.sizeBytes / chunkSize));
    const init = await fetchJson(
      "https://open.tiktokapis.com/v2/post/publish/video/init/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({
          post_info: {
            title: truncate(post.caption, 2200),
            privacy_level: privacyLevel,
            disable_comment: metadataBoolean(
              metadata,
              ["disableComment"],
              Boolean(creator.data?.comment_disabled),
            ),
            disable_duet: metadataBoolean(
              metadata,
              ["disableDuet"],
              Boolean(creator.data?.duet_disabled),
            ),
            disable_stitch: metadataBoolean(
              metadata,
              ["disableStitch"],
              Boolean(creator.data?.stitch_disabled),
            ),
            video_cover_timestamp_ms: Number(metadata.videoCoverTimestampMs ?? 1000),
            is_aigc: metadataBoolean(metadata, ["isAigc", "madeWithAi"], false),
          },
          source_info: {
            source: "FILE_UPLOAD",
            video_size: media.sizeBytes,
            chunk_size: chunkSize,
            total_chunk_count: totalChunkCount,
          },
        }),
      },
      "tiktok_publish_init_failed",
    ) as { data?: { upload_url?: string; publish_id?: string } };

    const uploadUrl = init.data?.upload_url;
    const publishId = init.data?.publish_id;
    if (!uploadUrl || !publishId) {
      throw new SocialPublisherError("tiktok_upload_url_missing", "TikTok did not return upload_url and publish_id");
    }

    const file = await readFile(media.localPath);
    for (let index = 0; index < totalChunkCount; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, media.sizeBytes) - 1;
      const chunk = file.subarray(start, end + 1);
      const uploadResponse = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": String(chunk.length),
          "Content-Range": `bytes ${start}-${end}/${media.sizeBytes}`,
        },
        body: chunk,
      });
      if (!uploadResponse.ok) {
        await readJsonResponse(uploadResponse, "tiktok_upload_failed");
      }
    }

    const status = await pollTikTokStatus(account.accessToken, publishId);
    const platformPostId =
      status.publiclyAvailablePostId ?? status.publicalyAvailablePostId ?? null;
    const username = creator.data?.creator_username ?? account.handle?.replace(/^@/, "");

    return {
      externalUrl: platformPostId && username
        ? `https://www.tiktok.com/@${username}/video/${platformPostId}`
        : null,
      metrics: null,
      metadata: {
        provider: "tiktok",
        publishId,
        platformPostId,
        tiktokStatus: status.status,
        privacyLevel,
      },
    };
  } finally {
    await media.cleanup();
  }
}

async function pollTikTokStatus(accessToken: string, publishId: string) {
  const attempts = Number(process.env.TIKTOK_STATUS_POLL_ATTEMPTS ?? "12");
  let latest: Record<string, unknown> = { status: "PROCESSING" };

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await wait(jitter(Number(process.env.TIKTOK_STATUS_POLL_INTERVAL_MS ?? "5000")));
    const response = await fetchJson(
      "https://open.tiktokapis.com/v2/post/publish/status/fetch/",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json; charset=UTF-8",
        },
        body: JSON.stringify({ publish_id: publishId }),
      },
      "tiktok_status_failed",
    ) as { data?: Record<string, unknown> };

    latest = response.data ?? latest;
    const status = String(latest.status ?? latest.status_code ?? "");
    if (status === "PUBLISH_COMPLETE" || status === "SEND_TO_USER_INBOX") break;
    if (status === "FAILED") {
      throw new SocialPublisherError("tiktok_publish_failed", "TikTok reported publish failure");
    }
  }

  return {
    status: String(latest.status ?? latest.status_code ?? "PROCESSING"),
    publiclyAvailablePostId:
      typeof latest.publicly_available_post_id === "string"
        ? latest.publicly_available_post_id
        : null,
    publicalyAvailablePostId:
      typeof latest.publicaly_available_post_id === "string"
        ? latest.publicaly_available_post_id
        : null,
  };
}

async function publishLinkedIn(
  account: PublishSocialAccount,
  post: ClaimedSocialPost,
  media: LocalMediaPayload,
): Promise<PublishResult> {
  try {
    const metadata = postMetadata(post);
    const accountMetadata = getAccountMetadata(account);
    const owner = metadataString(
      metadata,
      ["linkedinOwnerUrn"],
      metadataString(accountMetadata, ["ownerUrn"], `urn:li:person:${account.providerAccountId}`),
    );
    const headers = {
      Authorization: `Bearer ${account.accessToken}`,
      "Content-Type": "application/json",
      "Linkedin-Version": process.env.LINKEDIN_API_VERSION?.trim() || "202606",
      "X-Restli-Protocol-Version": "2.0.0",
    };

    const init = await fetchJson(
      "https://api.linkedin.com/rest/videos?action=initializeUpload",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          initializeUploadRequest: {
            owner,
            fileSizeBytes: media.sizeBytes,
            uploadCaptions: false,
            uploadThumbnail: false,
          },
        }),
      },
      "linkedin_video_init_failed",
    ) as {
      value?: {
        video?: string;
        uploadToken?: string;
        uploadInstructions?: Array<{
          uploadUrl?: string;
          firstByte?: number;
          lastByte?: number;
        }>;
      };
    };

    const videoUrn = init.value?.video;
    const uploadInstructions = init.value?.uploadInstructions ?? [];
    if (!videoUrn || uploadInstructions.length === 0) {
      throw new SocialPublisherError(
        "linkedin_video_upload_missing",
        "LinkedIn did not return video upload instructions",
      );
    }

    const file = await readFile(media.localPath);
    const uploadedPartIds: string[] = [];
    for (const instruction of uploadInstructions) {
      if (!instruction.uploadUrl || typeof instruction.firstByte !== "number" || typeof instruction.lastByte !== "number") {
        throw new SocialPublisherError("linkedin_video_upload_invalid", "LinkedIn returned invalid upload instructions");
      }
      const chunk = file.subarray(instruction.firstByte, instruction.lastByte + 1);
      const uploadResponse = await fetch(instruction.uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Type": "application/octet-stream",
          "Content-Length": String(chunk.length),
        },
        body: chunk,
      });
      if (!uploadResponse.ok) {
        await readJsonResponse(uploadResponse, "linkedin_video_upload_failed");
      }
      const etag = uploadResponse.headers.get("etag");
      if (!etag) {
        throw new SocialPublisherError("linkedin_video_etag_missing", "LinkedIn video upload did not return an ETag");
      }
      uploadedPartIds.push(etag.replace(/^"|"$/g, ""));
    }

    await fetchJson(
      "https://api.linkedin.com/rest/videos?action=finalizeUpload",
      {
        method: "POST",
        headers,
        body: JSON.stringify({
          finalizeUploadRequest: {
            video: videoUrn,
            uploadToken: init.value?.uploadToken ?? "",
            uploadedPartIds,
          },
        }),
      },
      "linkedin_video_finalize_failed",
    );

    const postResponse = await fetch("https://api.linkedin.com/rest/posts", {
      method: "POST",
      headers,
      body: JSON.stringify({
        author: owner,
        commentary: post.caption,
        visibility: metadataString(metadata, ["linkedinVisibility"], "PUBLIC"),
        distribution: {
          feedDistribution: "MAIN_FEED",
          targetEntities: [],
          thirdPartyDistributionChannels: [],
        },
        content: {
          media: {
            title: metadataString(metadata, ["title"], titleFromCaption(post.caption)),
            id: videoUrn,
          },
        },
        lifecycleState: "PUBLISHED",
        isReshareDisabledByAuthor: metadataBoolean(metadata, ["isReshareDisabledByAuthor"], false),
      }),
    });
    if (!postResponse.ok) {
      await readJsonResponse(postResponse, "linkedin_post_failed");
    }

    const linkedInPostId = postResponse.headers.get("x-restli-id");
    return {
      externalUrl: linkedInPostId
        ? `https://www.linkedin.com/feed/update/${linkedInPostId}/`
        : null,
      metrics: null,
      metadata: {
        provider: "linkedin",
        videoUrn,
        platformPostId: linkedInPostId,
      },
    };
  } finally {
    await media.cleanup();
  }
}

async function publishX(
  account: PublishSocialAccount,
  post: ClaimedSocialPost,
  media: LocalMediaPayload,
): Promise<PublishResult> {
  try {
    const metadata = postMetadata(post);
    const init = await fetchJson(
      "https://api.x.com/2/media/upload/initialize",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          media_category: "tweet_video",
          media_type: "video/mp4",
          total_bytes: media.sizeBytes,
          shared: false,
        }),
      },
      "x_media_init_failed",
    ) as { data?: { id?: string; media_key?: string } };
    const mediaId = init.data?.id;
    if (!mediaId) {
      throw new SocialPublisherError("x_media_id_missing", "X did not return a media id");
    }

    const file = await readFile(media.localPath);
    const chunkSize = Number(process.env.X_UPLOAD_CHUNK_BYTES ?? String(4 * 1024 * 1024));
    const totalChunks = Math.max(1, Math.ceil(media.sizeBytes / chunkSize));
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * chunkSize;
      const end = Math.min(start + chunkSize, media.sizeBytes);
      const chunk = file.subarray(start, end);
      const form = new FormData();
      form.set("segment_index", String(index));
      form.set("media", new Blob([chunk], { type: "video/mp4" }), media.fileName);

      const appendResponse = await fetch(`https://api.x.com/2/media/upload/${mediaId}/append`, {
        method: "POST",
        headers: { Authorization: `Bearer ${account.accessToken}` },
        body: form,
      });
      if (!appendResponse.ok) {
        await readJsonResponse(appendResponse, "x_media_append_failed");
      }
    }

    const finalize = await fetchJson(
      `https://api.x.com/2/media/upload/${mediaId}/finalize`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${account.accessToken}` },
      },
      "x_media_finalize_failed",
    ) as { data?: { processing_info?: { state?: string; check_after_secs?: number } } };

    await pollXMedia(account.accessToken, mediaId, finalize.data?.processing_info);

    const body: Record<string, unknown> = {
      text: truncate(post.caption, 280),
      media: { media_ids: [mediaId] },
    };
    if (metadataBoolean(metadata, ["madeWithAi", "isAigc"], false)) {
      body.made_with_ai = true;
    }

    const tweet = await fetchJson(
      "https://api.x.com/2/tweets",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${account.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
      "x_post_failed",
    ) as { data?: { id?: string } };

    if (!tweet.data?.id) {
      throw new SocialPublisherError("x_post_id_missing", "X did not return a post id");
    }

    const username = account.handle?.replace(/^@/, "");
    return {
      externalUrl: username
        ? `https://x.com/${username}/status/${tweet.data.id}`
        : `https://x.com/i/web/status/${tweet.data.id}`,
      metrics: null,
      metadata: {
        provider: "x",
        mediaId,
        mediaKey: init.data?.media_key ?? null,
        platformPostId: tweet.data.id,
      },
    };
  } finally {
    await media.cleanup();
  }
}

async function pollXMedia(
  accessToken: string,
  mediaId: string,
  initial?: { state?: string; check_after_secs?: number },
) {
  let processingInfo = initial;
  for (let attempt = 0; attempt < Number(process.env.X_MEDIA_POLL_ATTEMPTS ?? "20"); attempt += 1) {
    if (!processingInfo || processingInfo.state === "succeeded") return;
    if (processingInfo.state === "failed") {
      throw new SocialPublisherError("x_media_processing_failed", "X media processing failed");
    }
    await wait(jitter(Math.max(1, processingInfo.check_after_secs ?? 5) * 1000));
    const status = await fetchJson(
      `https://api.x.com/2/media/upload?${new URLSearchParams({
        command: "STATUS",
        media_id: mediaId,
      })}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
      },
      "x_media_status_failed",
    ) as { data?: { processing_info?: { state?: string; check_after_secs?: number } } };
    processingInfo = status.data?.processing_info;
  }

  throw new SocialPublisherError("x_media_processing_timeout", "X media processing did not finish in time");
}

function errorCode(error: unknown) {
  if (error instanceof SocialOAuthError) return error.code;
  return error instanceof SocialPublisherError ? error.code : "social_publish_failed";
}

export async function processDueSocialPosts() {
  const webhookUrl = getPublisherWebhookUrl();
  const claimed = await socialService.claimDuePosts(
    Number(process.env.SOCIAL_PUBLISH_BATCH_SIZE ?? "5"),
  );
  if (claimed.length === 0) return 0;

  let processed = 0;
  for (const post of claimed) {
    try {
      const result =
        post.socialAccountId && post.socialAccount
          ? await publishNativePost(post)
          : webhookUrl
            ? await deliverPost(webhookUrl, post)
            : (() => {
                throw new SocialPublisherError(
                  "social_account_missing",
                  "No connected account is selected and no publisher webhook fallback is configured",
                );
              })();
      await socialService.completePublishedPost(post.id, {
        externalUrl: result.externalUrl,
        metrics: result.metrics,
        metadata: result.metadata,
      });
      processed += 1;
      log("info", "social_post_published", {
        postId: post.id,
        projectId: post.projectId,
        platform: post.platform,
        externalUrl: result.externalUrl,
      });
    } catch (error) {
      const code = errorCode(error);
      await socialService.failPublishingPost(post.id, code).catch(() => {});
      processed += 1;
      log("error", "social_post_publish_failed", {
        postId: post.id,
        projectId: post.projectId,
        platform: post.platform,
        errorCode: code,
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  return processed;
}
