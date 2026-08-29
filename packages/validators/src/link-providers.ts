import { z } from "zod";
import { generationModeSchema } from "./content-pack";

export type LinkProviderId =
  | "youtube"
  | "gdrive"
  | "streamyard"
  | "loom"
  | "twitch"
  | "x"
  | "tiktok"
  | "linkedin"
  | "facebook"
  | "vimeo"
  | "dropbox";

export interface LinkProviderDef {
  id: LinkProviderId;
  label: string;
  strategy: "ytdlp" | "direct";
  /** Registrable hosts this provider matches. Subdomains match too
   *  (e.g. "www.youtube.com", "m.youtube.com" match "youtube.com"). */
  hosts: readonly string[];
}

export const LINK_PROVIDERS: readonly LinkProviderDef[] = [
  {
    id: "youtube",
    label: "YouTube",
    strategy: "ytdlp",
    hosts: ["youtube.com", "youtu.be", "youtube-nocookie.com"],
  },
  {
    id: "gdrive",
    label: "Google Drive",
    strategy: "ytdlp",
    hosts: ["drive.google.com"],
  },
  {
    id: "streamyard",
    label: "StreamYard",
    strategy: "ytdlp",
    hosts: ["streamyard.com"],
  },
  {
    id: "loom",
    label: "Loom",
    strategy: "ytdlp",
    hosts: ["loom.com"],
  },
  {
    id: "twitch",
    label: "Twitch",
    strategy: "ytdlp",
    hosts: ["twitch.tv"],
  },
  {
    id: "x",
    label: "X (Twitter)",
    strategy: "ytdlp",
    hosts: ["x.com", "twitter.com"],
  },
  {
    id: "tiktok",
    label: "TikTok",
    strategy: "ytdlp",
    hosts: ["tiktok.com"],
  },
  {
    id: "linkedin",
    label: "LinkedIn",
    strategy: "ytdlp",
    hosts: ["linkedin.com"],
  },
  {
    id: "facebook",
    label: "Facebook",
    strategy: "ytdlp",
    hosts: ["facebook.com", "fb.watch", "fb.com"],
  },
  {
    id: "vimeo",
    label: "Vimeo",
    strategy: "ytdlp",
    hosts: ["vimeo.com"],
  },
  {
    id: "dropbox",
    label: "Dropbox",
    strategy: "direct",
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

export const linkIngestSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  url: z.string().url().refine((value) => detectLinkProvider(value) !== null, {
    message:
      "We couldn't recognize that link. Supported: YouTube, Google Drive, StreamYard, Loom, Twitch, X, TikTok, LinkedIn, Facebook, Vimeo, Dropbox.",
  }),
  brandTemplateId: z.string().uuid().nullable().optional(),
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
