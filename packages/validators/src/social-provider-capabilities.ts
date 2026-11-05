export const SOCIAL_PROVIDER_CAPABILITIES = {
  youtube_shorts: {
    version: "youtube-v3", apiVersion: "v3", requiredScopes: ["https://www.googleapis.com/auth/youtube.upload", "https://www.googleapis.com/auth/youtube.readonly"],
    connectionEnabled: true, publishingEnabled: true, aspectRatios: ["9:16", "1:1", "16:9", "4:5"],
    durationSec: { min: 1, max: 43_200 }, textLimit: 5_000, thumbnailTypes: ["provider_default", "custom_image"], thumbnailSources: ["uploaded", "generated", "extracted_frame"], titleField: true, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  instagram_reels: {
    version: "v24.0", apiVersion: "v24.0", requiredScopes: ["instagram_basic", "instagram_content_publish", "pages_show_list", "pages_read_engagement", "business_management"],
    connectionEnabled: true, publishingEnabled: true, aspectRatios: ["9:16", "1:1", "4:5"],
    durationSec: { min: 3, max: 900 }, textLimit: 2_200, thumbnailTypes: ["video_frame", "custom_image"], thumbnailSources: ["uploaded", "generated", "extracted_frame"], titleField: false, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  // No title field: the Reels finish call sends only the caption as its description.
  facebook_reels: {
    version: "facebook-reels-2026-08-31", apiVersion: "v24.0", requiredScopes: ["pages_show_list", "pages_read_engagement", "pages_manage_posts"],
    connectionEnabled: true, publishingEnabled: true, aspectRatios: ["9:16"],
    durationSec: { min: 4, max: 60 }, textLimit: 2_200, thumbnailTypes: ["provider_default"], thumbnailSources: [], titleField: false, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  tiktok: {
    version: "tiktok-v2", apiVersion: "v2", requiredScopes: ["user.info.basic", "video.list", "video.upload", "video.publish"],
    connectionEnabled: true, publishingEnabled: true, aspectRatios: ["9:16"],
    durationSec: { min: 3, max: 600 }, textLimit: 2_200, thumbnailTypes: ["video_frame"], thumbnailSources: ["extracted_frame"], titleField: true, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  linkedin: {
    version: "202608", apiVersion: "202608", requiredScopes: ["openid", "profile", "w_member_social"],
    connectionEnabled: true, publishingEnabled: true, aspectRatios: ["9:16", "1:1", "16:9", "4:5"],
    durationSec: { min: 1, max: 600 }, textLimit: 3_000, thumbnailTypes: ["provider_default"], thumbnailSources: [], titleField: false, firstCommentField: false, providerPolling: true, scheduling: true,
  },
  x: {
    version: "x-v2", apiVersion: "v2", requiredScopes: ["tweet.read", "tweet.write", "users.read", "offline.access", "media.write"],
    connectionEnabled: true, publishingEnabled: true, aspectRatios: ["9:16", "1:1", "16:9", "4:5"],
    durationSec: { min: 0.5, max: 140 }, textLimit: 280, thumbnailTypes: ["provider_default"], thumbnailSources: [], titleField: false, firstCommentField: false, providerPolling: true, scheduling: true,
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

/** X counts a post in weighted units: most Latin text is 1, CJK and other wide
 * scripts are 2, an emoji is 2 and a link is always 23 (twitter-text's config).
 * A link is `http(s)://...` or a bare domain on a generic TLD (or `co`/`tv`);
 * any other two-letter TLD counts only with a path, as twitter-text does. The
 * sentence punctuation that trails a link stays ordinary text. */
const X_LIGHT_CODE_POINTS = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]] as const;
const X_LINK_WEIGHT = 23;
const X_GENERIC_TLDS = "com|net|org|edu|gov|mil|int|info|biz|name|pro|mobi|app|dev|io|ai|xyz|online|site|tech|store|shop|blog|news|live|link|page|cloud|co|tv";
const X_LINK = new RegExp(
  `(?<![\\p{L}\\p{N}_@.#$/-])(?:https?:\\/\\/[^\\s]+|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\\.){1,5}(?:(?:${X_GENERIC_TLDS})(?![a-z0-9-])|[a-z]{2}(?=\\/))(?::\\d{1,5})?(?:\\/[^\\s]*)?)`,
  "giu",
);
const X_EMOJI = /\p{RI}{2}|(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F)\p{Emoji_Modifier}?(?:\u200D(?:\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F?)\p{Emoji_Modifier}?)*|[0-9#*]\uFE0F\u20E3/gu;

/** The punctuation at the end of a matched link that belongs to the sentence. A
 * closing parenthesis stays with the link while it balances one inside it. */
function xLinkTail(link: string): string {
  let end = link.length, open = 0, close = 0;
  for (const c of link) { if (c === "(") open += 1; else if (c === ")") close += 1; }
  for (;;) {
    const last = link[end - 1];
    if (last && ".,;:!?'\"".includes(last)) end -= 1;
    else if (last === ")" && close > open) { end -= 1; close -= 1; }
    else break;
  }
  return link.slice(end);
}

export function xWeightedLength(text: string): number {
  let weight = 0;
  const plain = text.normalize("NFC")
    .replace(X_LINK, (link) => { weight += X_LINK_WEIGHT; return xLinkTail(link); })
    .replace(X_EMOJI, () => { weight += 2; return ""; });
  for (const character of plain) {
    const point = character.codePointAt(0)!;
    weight += X_LIGHT_CODE_POINTS.some(([from, to]) => point >= from && point <= to) ? 1 : 2;
  }
  return weight;
}

/** A caption's length in the units the platform's limit is written in. */
export function socialCaptionLength(platform: SocialProviderCapabilityPlatform, text: string): number {
  return platform === "x" ? xWeightedLength(text) : text.length;
}
