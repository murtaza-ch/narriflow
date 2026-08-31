export const SOCIAL_PROVIDER_CAPABILITIES = {
  youtube_shorts: {
    version: "youtube-shorts-v2", apiVersion: "v3", requiredScopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    connectionEnabled: true, publishingEnabledByDefault: true, aspectRatios: ["9:16", "1:1", "4:5"],
    durationSec: { min: 1, max: 180 }, textLimit: 5_000, thumbnailTypes: ["provider_default", "custom_image"], customThumbnail: { contentTypes: ["image/jpeg", "image/png"], maxSizeBytes: 2 * 1024 * 1024 }, titleField: true, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  instagram_reels: {
    version: "instagram-reels-v2", apiVersion: "v24.0", requiredScopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"],
    connectionEnabled: true, publishingEnabledByDefault: true, aspectRatios: ["9:16", "1:1", "4:5"],
    durationSec: { min: 3, max: 900 }, textLimit: 2_200, thumbnailTypes: ["provider_default", "video_frame"], customThumbnail: null, titleField: false, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  facebook_reels: {
		version: "facebook-reels-v2", apiVersion: "v24.0", requiredScopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    connectionEnabled: true, publishingEnabledByDefault: false, aspectRatios: ["9:16"],
		durationSec: { min: 4, max: 60 }, textLimit: 2_200, thumbnailTypes: ["provider_default"], customThumbnail: null, titleField: true, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  tiktok: {
    version: "tiktok-v3", apiVersion: "v2", requiredScopes: ["user.info.basic", "video.list", "video.upload", "video.publish"],
    connectionEnabled: true, publishingEnabledByDefault: true, aspectRatios: ["9:16"],
    durationSec: { min: 3, max: 600 }, textLimit: 2_200, thumbnailTypes: ["provider_default", "video_frame"], customThumbnail: null, titleField: true, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  linkedin: {
    version: "202608", apiVersion: "202608", requiredScopes: ["openid", "profile", "w_member_social"],
    connectionEnabled: true, publishingEnabledByDefault: true, aspectRatios: ["9:16", "1:1", "16:9", "4:5"],
    durationSec: { min: 1, max: 600 }, textLimit: 3_000, thumbnailTypes: ["provider_default"], customThumbnail: null, titleField: false, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  x: {
    version: "x-v2", apiVersion: "v2", requiredScopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"],
    connectionEnabled: true, publishingEnabledByDefault: true, aspectRatios: ["9:16", "1:1", "16:9", "4:5"],
    durationSec: { min: 0.5, max: 140 }, textLimit: 280, thumbnailTypes: ["provider_default"], customThumbnail: null, titleField: false, firstCommentField: false, providerPolling: true, scheduling: true,
  },
} as const;

export type SocialProviderCapabilityPlatform = keyof typeof SOCIAL_PROVIDER_CAPABILITIES;

export function socialProviderAcceptsMedia(input: {
  platform: SocialProviderCapabilityPlatform;
  aspectRatio: string;
  durationSec: number;
}) {
  const capability = SOCIAL_PROVIDER_CAPABILITIES[input.platform];
  return capability.aspectRatios.some((ratio) => ratio === input.aspectRatio) &&
    input.durationSec >= capability.durationSec.min &&
    input.durationSec <= capability.durationSec.max;
}

export function socialProviderAcceptsCustomThumbnail(input: {
  platform: SocialProviderCapabilityPlatform;
  contentType: string;
  sizeBytes: number;
}) {
  const contract = SOCIAL_PROVIDER_CAPABILITIES[input.platform].customThumbnail;
  return contract !== null &&
    Number.isSafeInteger(input.sizeBytes) &&
    input.sizeBytes > 0 &&
    input.sizeBytes <= contract.maxSizeBytes &&
    contract.contentTypes.some((contentType) => contentType === input.contentType);
}
