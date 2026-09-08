import { Box } from "@chakra-ui/react";
import {
  Facebook, FileVideo, Linkedin, Link2, Music2, PackageOpen,
  Radio, Rss, Triangle, Twitch, Video, Videotape, Waypoints, Youtube,
  type LucideIcon,
} from "lucide-react";
import { LINK_PROVIDERS, type LinkProviderId } from "@narriflow/validators";

const providerIcons: Record<LinkProviderId, LucideIcon> = {
  youtube: Youtube,
  gdrive: Triangle,
  streamyard: Radio,
  loom: Waypoints,
  twitch: Twitch,
  x: Link2,
  tiktok: Music2,
  linkedin: Linkedin,
  facebook: Facebook,
  vimeo: Videotape,
  dropbox: PackageOpen,
};

export function SourceIcon({ sourceType, sourceProvider }: {
  sourceType: string;
  sourceProvider: string | null;
}) {
  const provider = sourceType === "link"
    ? LINK_PROVIDERS.find((item) => item.id === sourceProvider)
    : undefined;
  const Icon = provider ? providerIcons[provider.id]
    : sourceType === "youtube" ? Youtube
    : sourceType === "upload" ? FileVideo
    : sourceType === "rss" ? Rss
    : sourceType === "link" ? Link2 : Video;
  const label = provider?.label ?? ({ youtube: "YouTube", upload: "Uploaded video", rss: "RSS feed", link: "Video link" } as Record<string, string>)[sourceType] ?? "Video source";

  return (
    <Box as="span" display="inline-flex" color="fg.subtle" role="img" aria-label={label} title={label} flexShrink={0}>
      {provider?.id === "x" ? (
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          <path d="M4 3h4l12 18h-4L4 3ZM20 3l-7 8M4 21l7-8" />
        </svg>
      ) : <Icon size={15} aria-hidden="true" />}
    </Box>
  );
}
