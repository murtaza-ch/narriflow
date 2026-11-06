"use client";
import { Box, chakra, Flex, Stack, Text } from "@chakra-ui/react";
import { AlertCircle, CheckCircle2, Film } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { Spinner } from "@narriflow/ui/components/spinner";
import type { ClipExportSnapshot, ClipSnapshot } from "@narriflow/validators";
import { formatDuration } from "@/lib/format";
import { PublishingPreview } from "./publishing-preview";
import { CLIP_RENDER_STATE_LABELS, clipRenderInFlight, type ClipRenderState } from "./publishing-render-state";

const STATE_COLORS: Record<ClipRenderState["kind"], string> = {
	checking: "fg.muted",
	none: "fg.muted",
	queued: "accent.fg",
	rendering: "accent.fg",
	ready: "success.fg",
	failed: "danger.fg",
};

/** Queued and Rendering stay words: a render reports no percentage worth showing. */
export function RenderStateLabel({ state, size = "xs" }: { state: ClipRenderState; size?: string }) {
	return (
		<Flex as="span" display="inline-flex" align="center" gap="1" fontSize={size} color={STATE_COLORS[state.kind]}>
			{clipRenderInFlight(state) && <Spinner size="xs" />}
			{state.kind === "ready" && <CheckCircle2 size={12} aria-hidden />}
			{state.kind === "failed" && <AlertCircle size={12} aria-hidden />}
			{CLIP_RENDER_STATE_LABELS[state.kind]}
		</Flex>
	);
}

/** One segment per clip. It counts clips, never a percentage of one render. */
function RenderStrip({ states }: { states: ClipRenderState[] }) {
	return (
		<Flex aria-hidden flex="1" maxW="240px" gap="2px">
			{states.map((state, index) => (
				<Box
					key={index}
					flex="1"
					h="4px"
					borderRadius="full"
					bg={state.kind === "failed" ? "danger.fg" : state.kind === "ready" || clipRenderInFlight(state) ? "accent.fg" : "bg.soft"}
					animation={clipRenderInFlight(state) ? "pulse 1.6s ease-in-out infinite" : undefined}
				/>
			))}
		</Flex>
	);
}

export function RenderSummary({ summary, states }: { summary: string; states: ClipRenderState[] }) {
	return (
		<Flex align="center" justify="space-between" gap="4">
			<Text role="status" fontSize="13px" color="fg.muted" fontVariantNumeric="tabular-nums">
				{summary}
			</Text>
			<RenderStrip states={states} />
		</Flex>
	);
}

/** A second in, past the black lead-in many clips open on. */
const posterSource = (url: string) => `${url}#t=1`;

export type ClipRailItem = {
	clip: ClipSnapshot;
	render: ClipRenderState;
	needsReview: boolean;
	preview: ClipExportSnapshot["variants"][number] | undefined;
};

export function PublishingClipRail({ items, activeId, onSelect }: { items: ClipRailItem[]; activeId: string; onSelect(id: string): void }) {
	return (
		<Stack
			as="nav"
			aria-label="Selected clips"
			direction="row"
			gap="2"
			flexShrink={0}
			width="full"
			overflowX="auto"
			overflowY="hidden"
			display={{ base: "none", md: "flex" }}
			css={{ scrollbarWidth: "none", "&::-webkit-scrollbar": { display: "none" } }}
		>
			{items.map(({ clip, render, needsReview, preview }) => {
				const current = clip.id === activeId;
				const title = clip.title ?? clip.hookText;
				return (
					<Button
						key={clip.id}
						variant="ghost"
						aria-current={current ? "true" : undefined}
						bg={current ? "accent.subtle" : "bg.subtle"}
						_hover={{ bg: current ? "accent.subtle" : "bg.soft" }}
						width="232px"
						minW="232px"
						h="auto"
						p="2"
						flexShrink={0}
						gap="3"
						justifyContent="start"
						alignItems="stretch"
						whiteSpace="normal"
						textAlign="start"
						borderRadius="l3"
						onClick={() => onSelect(clip.id)}
					>
						<Box position="relative" width="60px" height="106px" flexShrink={0} borderRadius="l2" overflow="hidden" bg="bg.panel">
							{preview?.previewUrl ? (
								<PublishingPreview
									key={preview.id}
									muted
									preload="metadata"
									aria-label={`Preview of ${title}`}
									src={posterSource(preview.previewUrl)}
									style={{ width: "100%", height: "100%", objectFit: "cover" }}
								/>
							) : (
								<Flex h="full" align="center" justify="center" color="fg.muted">
									<Film size={18} />
								</Flex>
							)}
							<chakra.span
								position="absolute"
								insetEnd="1"
								bottom="1"
								px="1"
								borderRadius="4px"
								bg="rgba(0, 0, 0, 0.6)"
								color="white"
								fontSize="10px"
								lineHeight="14px"
								fontVariantNumeric="tabular-nums"
							>
								{formatDuration(clip.durationSec)}
							</chakra.span>
						</Box>
						<Stack gap="1" minW="0" flex="1" py="1" justify="space-between">
							<Text fontSize="13px" fontWeight="500" lineHeight="1.35" lineClamp={3} color="fg">
								{title}
							</Text>
							<Stack gap="0.5">
								<RenderStateLabel state={render} />
								{needsReview && (
									<Text fontSize="xs" color="fg.muted">
										Needs review
									</Text>
								)}
							</Stack>
						</Stack>
					</Button>
				);
			})}
		</Stack>
	);
}
