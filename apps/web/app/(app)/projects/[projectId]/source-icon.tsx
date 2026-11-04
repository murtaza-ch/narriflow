import { Box } from "@chakra-ui/react";
import { FileVideo, Link2, PackageOpen, Rss, Triangle, Video, Youtube, type LucideIcon } from "lucide-react";
import { LINK_PROVIDERS, type LinkProviderId } from "@narriflow/validators";

const providerIcons: Record<LinkProviderId, LucideIcon> = {
  youtube: Youtube,
  gdrive: Triangle,
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
      <Icon size={15} aria-hidden="true" />
    </Box>
  );
}
