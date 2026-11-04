import { z } from "zod";
import { generationModeSchema } from "./content-pack";

export type LinkProviderId = "youtube" | "gdrive" | "dropbox";

export interface LinkProviderDef {
  id: LinkProviderId;
  label: string;
  /** Registrable hosts a pasted link may come from. Subdomains match too
   *  (e.g. "www.youtube.com", "m.youtube.com" match "youtube.com"). */
  hosts: readonly string[];
}

/** Every source a link intake can actually read. A host listed here must have a working acquisition path. */
export const LINK_PROVIDERS: readonly LinkProviderDef[] = [
  {
    id: "youtube",
    label: "YouTube",
    hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  },
  {
    // Files arrive through the Drive Picker and its token, never a pasted link.
    id: "gdrive",
    label: "Google Drive",
    hosts: [],
  },
  {
    id: "dropbox",
    label: "Dropbox",
    hosts: ["dropbox.com"],
  },
] as const;

/** True if `hostname` is exactly `base`, or a subdomain of it
 *  (e.g. "www.youtube.com" / "m.youtube.com" match "youtube.com"). */
function hostMatches(hostname: string, base: string): boolean {
  return hostname === base || hostname.endsWith(`.${base}`);
}

export function detectLinkProvider(url: string): LinkProviderId | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return null;
  }

  const hostname = parsed.hostname.toLowerCase();

  for (const provider of LINK_PROVIDERS) {
    if (provider.hosts.some((host) => hostMatches(hostname, host))) {
      return provider.id;
    }
  }

  return null;
}

const YOUTUBE_MEDIA_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE_HOSTS = ["youtube.com", "www.youtube.com", "m.youtube.com", "youtube-nocookie.com", "www.youtube-nocookie.com"];

/** The one video a YouTube link names, or null for a channel, playlist or anything else. */
export function youtubeMediaId(input: string): string | null {
  if (input.length > 2048 || [...input].some((char) => char.charCodeAt(0) <= 32 || char.charCodeAt(0) === 127)) return null;
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return null;
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return null;
  let id: string | null | undefined = null;
  if (url.hostname === "youtu.be" && /^\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) id = url.pathname.split("/")[1];
  else if (YOUTUBE_HOSTS.includes(url.hostname)) {
    if (url.pathname === "/watch" && url.searchParams.getAll("v").length === 1) id = url.searchParams.get("v");
    else if (/^\/(?:shorts|embed|live)\/[A-Za-z0-9_-]{11}\/?$/.test(url.pathname)) id = url.pathname.split("/")[2];
  }
  return id && YOUTUBE_MEDIA_ID.test(id) ? id : null;
}

/** Hosts are refused at intake with `link_unsupported_source`, a stable code every caller can read. */
export const linkIngestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  url: z.string().url(),
  brandTemplateId: z.string().uuid().nullable().optional(),
  brandProfileId: z.string().uuid().nullable().optional(),
  // Link-first split (Step 1 · Commit). commitToken makes repeated submits
  // collapse on the Project.commitToken unique; the draft fields seed the
  // draft ContentPack so a refresh of Step 2 can rehydrate them.
  commitToken: z.string().uuid().optional(),
  languageCode: z.string().min(2).max(16).nullable().optional(),
  mode: generationModeSchema.optional(),
  processingStartSec: z.number().int().min(0).nullable().optional(),
  processingEndSec: z.number().int().min(0).nullable().optional(),
}).strict();

export type LinkIngestInput = z.infer<typeof linkIngestSchema>;
