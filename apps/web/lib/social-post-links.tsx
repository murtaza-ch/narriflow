import { Flex } from "@chakra-ui/react";
import { ExternalLink } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
/** The same reported links are shown in Calendar, Posts, and clip status drawers. */
export function SocialPostLinks({
	post,
	compact = false,
}: {
	compact?: boolean;
	post: {
		externalUrl: string | null;
		publishedVideos?: Array<{
			platformPostId: string;
			externalUrl: string | null;
		}>;
	};
}) {
	const urls = [
		...new Set(
			(post.publishedVideos?.length
				? post.publishedVideos.map((v) => v.externalUrl)
				: [post.externalUrl]
			).filter((url): url is string => !!url),
		),
	];
	return (
		<Flex gap="2" wrap="wrap">
			{urls.map((url, index) => (
				<Button key={url} size="xs" variant="ghost" asChild>
					<a
						aria-label={`View post${urls.length > 1 ? ` ${index + 1}` : ""}`}
						title="View post"
						href={url}
						target="_blank"
						rel="noreferrer"
					>
						<ExternalLink size={12} />
						{!compact && <>View post{urls.length > 1 ? ` ${index + 1}` : ""}</>}
					</a>
				</Button>
			))}
		</Flex>
	);
}
