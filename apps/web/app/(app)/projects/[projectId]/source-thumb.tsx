import { UploadThumb } from "../_components/project-thumbnail";
import type { ProjectListItem } from "../_lib/api";
import Image from "next/image";
import { Box, Flex } from "@chakra-ui/react";
import { Film, Link2 } from "lucide-react";
import { gradientForId } from "../_lib/gradient";
import { extractYoutubeId, youtubeThumbnailUrl } from "../_lib/youtube";

/** Private uploaded poster or provider frame, with a stable placeholder when unavailable. */
export function SourceThumb({
	projectId,
	title,
	sourceType,
	sourceInput,
	sourceMediaUrl,
  thumbnail,
}: {
	projectId: string;
	title: string;
	sourceType: string;
	sourceInput: string | null;
	sourceMediaUrl: string;
  thumbnail?: ProjectListItem["thumbnail"];
}) {
  if (thumbnail) return <UploadThumb key={`${projectId}:${sourceMediaUrl}`} project={{ id: projectId, sourceType: "upload", thumbnail }} priority variant="card" sizes="(min-width: 768px) 232px, 100vw" />;
	const youtubeId =
		sourceType === "youtube"
			? extractYoutubeId(sourceInput, sourceMediaUrl)
			: null;

	if (youtubeId) {
		return (
			<Image
				src={youtubeThumbnailUrl(youtubeId, "hq")}
				alt={title}
				fill
				sizes="256px"
				loading="eager"
				style={{ objectFit: "cover" }}
			/>
		);
	}

	const gradient = gradientForId(projectId);
	return (
		<Flex
			w="full"
			h="full"
			align="center"
			justify="center"
			style={{
				background: `linear-gradient(135deg, ${gradient.from}, ${gradient.to})`,
			}}
		>
			<Box color="whiteAlpha.700">
				{sourceType === "link" ? (
					<Link2 size={20} aria-hidden />
				) : (
					<Film size={20} aria-hidden />
				)}
			</Box>
		</Flex>
	);
}
