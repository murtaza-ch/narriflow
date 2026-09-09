import { Box, Image } from "@chakra-ui/react";
import type { SocialPlatform } from "@narriflow/validators";
import { SOCIAL_PLATFORM_LABELS } from "./social-post-status";
const icons: Record<SocialPlatform, { light: string; dark?: string }> = {
	tiktok: { light: "tiktok-light.svg", dark: "tiktok-dark.svg" },
	youtube_shorts: { light: "youtube.svg" },
	instagram_reels: { light: "instagram.svg" },
	facebook_reels: { light: "facebook.svg" },
	linkedin: { light: "linkedin.svg" },
	x: { light: "x-light.svg", dark: "x-dark.svg" },
};
export function SocialPlatformMark({
	platform,
	size = "5",
}: {
	platform: SocialPlatform;
	size?: "4" | "5" | "6";
}) {
	const icon = icons[platform];
	return (
		<Box boxSize={size} flexShrink={0} title={SOCIAL_PLATFORM_LABELS[platform]}>
			<Image
				src={`/images/social/${icon.light}`}
				alt={SOCIAL_PLATFORM_LABELS[platform]}
				boxSize="full"
				objectFit="contain"
				_dark={icon.dark ? { display: "none" } : undefined}
			/>
			{icon.dark && (
				<Image
					src={`/images/social/${icon.dark}`}
					alt={SOCIAL_PLATFORM_LABELS[platform]}
					boxSize="full"
					objectFit="contain"
					display="none"
					_dark={{ display: "block" }}
				/>
			)}
		</Box>
	);
}
