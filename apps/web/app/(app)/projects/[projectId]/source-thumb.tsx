import Image from "next/image";
import { Box, Flex } from "@chakra-ui/react";
import { Film, Link2 } from "lucide-react";
import { gradientForId } from "../_lib/gradient";
import { extractYoutubeId, youtubeThumbnailUrl } from "../_lib/youtube";

/** The source's poster: the YouTube frame when there is one, else a gradient keyed to the Project. */
export function SourceThumb({
	projectId,
	title,
	sourceType,
	sourceInput,
	sourceMediaUrl,
}: {
	projectId: string;
	title: string;
	sourceType: string;
	sourceInput: string | null;
	sourceMediaUrl: string;
}) {
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
