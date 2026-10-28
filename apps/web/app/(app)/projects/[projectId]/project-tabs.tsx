"use client";

import type { ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Box, Tabs } from "@chakra-ui/react";
import { type ProjectTab, projectTabFromSearchParam } from "./project-tab";

const TABS: ReadonlyArray<{ value: ProjectTab; label: string }> = [
	{ value: "clips", label: "Clips" },
	{ value: "transcript", label: "Transcript" },
	{ value: "repurpose", label: "Repurpose" },
	{ value: "dubbing", label: "Dubbing" },
	{ value: "review", label: "Review" },
	{ value: "posts", label: "Posts" },
	{ value: "analytics", label: "Analytics" },
	{ value: "activity", label: "Activity" },
];

/** Project destinations preserve their URL selection. Clip composition stays in a drawer. */
export function ProjectTabs({
	clipsCountBadge,
	children,
}: {
	clipsCountBadge: ReactNode;
	children: ReactNode;
}) {
	const router = useRouter();
	const pathname = usePathname();
	const searchParams = useSearchParams();
	const value = projectTabFromSearchParam(searchParams.get("tab"));

	function handleValueChange(details: { value: string }) {
		const params = new URLSearchParams(searchParams.toString());
		if (details.value === "clips") {
			params.delete("tab");
		} else {
			params.set("tab", details.value);
		}
		const query = params.toString();
		router.replace(query ? `${pathname}?${query}` : pathname, {
			scroll: false,
		});
	}

	return (
		<Tabs.Root
			value={value}
			onValueChange={handleValueChange}
			variant="line"
			size="sm"
			colorPalette="accent"
			w="full"
			minW="0"
			maxW="full"
			animation="fade-up"
			animationFillMode="backwards"
			style={{ animationDelay: "180ms" }}
		>
			<Tabs.List
				w="full"
				minW="0"
				maxW="full"
				gap={{ base: "5", md: "7" }}
				overflowX="auto"
				overflowY="hidden"
				css={{
					// Eight short labels scroll sideways on a narrow screen; the bar
					// draws no scrollbar of its own.
					scrollbarWidth: "none",
					"&::-webkit-scrollbar": { display: "none" },
					"--indicator-thickness": "2px",
				}}
			>
				{TABS.map(({ value: tab, label }) => (
					<Tabs.Trigger
						key={tab}
						value={tab}
						px="0.5"
						fontSize="14px"
						color="fg.subtle"
						flexShrink={0}
						whiteSpace="nowrap"
						transition="color 120ms ease"
						_hover={{ color: "fg" }}
						_selected={{ color: "fg" }}
					>
						{label}
						{tab === "clips" ? clipsCountBadge : null}
					</Tabs.Trigger>
				))}
			</Tabs.List>
			{children}
		</Tabs.Root>
	);
}

/** Small count beside the Clips tab: a soft chip that turns accent with its tab.
 *  Pulled out so page.tsx can compute it server-side and pass it through as a node. */
export function TabCountBadge({ count }: { count: number }) {
	if (count <= 0) return null;
	return (
		<Box
			as="span"
			ms="1.5"
			minW="5"
			px="1.5"
			bg="bg.soft"
			borderRadius="full"
			display="inline-block"
			textAlign="center"
			fontWeight="500"
			fontSize="11px"
			lineHeight="20px"
			fontVariantNumeric="tabular-nums"
			color="fg.muted"
			transition="background-color 120ms ease, color 120ms ease"
			css={{
				"[role=tab][data-selected] > &": {
					background: "var(--chakra-colors-accent-subtle)",
					color: "var(--chakra-colors-accent-fg)",
				},
			}}
		>
			{count}
		</Box>
	);
}
