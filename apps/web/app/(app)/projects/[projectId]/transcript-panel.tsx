"use client";

import { useMemo, useState } from "react";
import { AlertTriangle, Download, FileText, Search } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { StatBand } from "@narriflow/ui/components/stat-band";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { userErrorMessage, type TranscriptSnapshot } from "@narriflow/validators";
import { Box, Flex, Group, Input, Stack, Text } from "@chakra-ui/react";
import { formatDuration, formatTimecode } from "@/lib/format";
import { PanelHeader } from "./panel-header";

/** Speakers keep one tint each, in order of first appearance. */
const SPEAKER_PALETTES = ["accent", "success", "warning", "danger"] as const;

function escapeRegExp(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Wraps each case-insensitive match of `query` in a highlight. */
function highlight(text: string, query: string) {
	if (!query) return text;
	const parts = text.split(new RegExp(`(${escapeRegExp(query)})`, "gi"));
	return parts.map((part, index) =>
		index % 2 === 1 ? (
			<Box
				as="mark"
				key={index}
				bg="accent.muted"
				color="fg"
				borderRadius="2px"
				px="0.5"
			>
				{part}
			</Box>
		) : (
			part
		),
	);
}

export function TranscriptPanel({
	projectId,
	transcript,
}: {
	projectId: string;
	transcript: TranscriptSnapshot | null;
}) {
	const [query, setQuery] = useState("");
	const needle = query.trim();

	const stats = useMemo(() => {
		if (!transcript) return null;
		const withConfidence = transcript.utterances.filter(
			(utterance) => typeof utterance.confidence === "number",
		);
		const averageConfidence =
			withConfidence.length > 0
				? withConfidence.reduce((sum, utterance) => sum + (utterance.confidence ?? 0), 0) /
					withConfidence.length
				: null;
		const withWords = transcript.utterances.filter(
			(utterance) => utterance.words.length > 0,
		).length;
		const wordCount = transcript.utterances.reduce(
			(sum, utterance) =>
				sum +
				(utterance.words.length > 0
					? utterance.words.length
					: utterance.text.split(/\s+/).filter(Boolean).length),
			0,
		);
		return {
			averageConfidence,
			wordTiming:
				transcript.utterances.length > 0
					? Math.round((withWords / transcript.utterances.length) * 100)
					: null,
			wordCount,
			durationSec: transcript.utterances.at(-1)?.endSec ?? null,
		};
	}, [transcript]);

	const speakerPalette = useMemo(() => {
		const map = new Map<string, (typeof SPEAKER_PALETTES)[number]>();
		for (const utterance of transcript?.utterances ?? []) {
			if (!map.has(utterance.speakerLabel)) {
				map.set(
					utterance.speakerLabel,
					SPEAKER_PALETTES[map.size % SPEAKER_PALETTES.length]!,
				);
			}
		}
		return map;
	}, [transcript]);

	const visibleUtterances = useMemo(() => {
		const utterances = transcript?.utterances ?? [];
		if (needle.length < 2) return utterances;
		const lower = needle.toLowerCase();
		return utterances.filter((utterance) => utterance.text.toLowerCase().includes(lower));
	}, [transcript, needle]);

	if (!transcript || !stats) {
		return (
			<EmptyState
				icon={<FileText size={22} aria-hidden />}
				title="No transcript yet"
				description="When the video is transcribed, you can read it here and download subtitle files."
			/>
		);
	}

	const isReady = transcript.status === "completed";
	const searching = needle.length >= 2;

	return (
		<Stack gap="6">
			<PanelHeader
				icon={<FileText size={20} />}
				title="Transcript"
				badge={
					isReady ? null : (
						<StatusBadge status={transcript.status as "processing" | "failed"} />
					)
				}
				description="Who said what, timed to the word. Your clips, captions and subtitle files all come from this text."
				actions={
					isReady ? (
						<Group attached>
							{["txt", "srt", "vtt"].map((format, index) => (
								<Button key={format} asChild size="sm" variant="outline">
									<a
										href={`/api/projects/${projectId}/transcript/export?format=${format}`}
										aria-label={`Download ${format.toUpperCase()}`}
									>
										{index === 0 ? <Download size={13} /> : null}
										{format.toUpperCase()}
									</a>
								</Button>
							))}
						</Group>
					) : null
				}
			/>

			{transcript.errorCode ? (
				<Flex
					role="alert"
					align="center"
					gap="2"
					color="danger.fg"
					borderStartWidth="3px"
					borderColor="danger.solid"
					ps="3"
					py="2"
				>
					<AlertTriangle size={14} aria-hidden />
					<Text fontSize="sm">{userErrorMessage(transcript.errorCode)}</Text>
				</Flex>
			) : null}

			<StatBand columns={6} pt="0">
				<StatBand.Item
					label="Language"
					value={(transcript.languageCode ?? "—").toUpperCase()}
					suffix={
						typeof transcript.languageConfidence === "number" ? (
							<Text textStyle="data" fontSize="11px" color="fg.subtle">
								{Math.round(transcript.languageConfidence * 100)}%
							</Text>
						) : null
					}
				/>
				<StatBand.Item
					label="Speakers"
					value={transcript.speakerCount ?? speakerPalette.size}
				/>
				<StatBand.Item label="Words" value={stats.wordCount.toLocaleString()} />
				<StatBand.Item
					label="Duration"
					value={stats.durationSec !== null ? formatDuration(stats.durationSec) : "—"}
				/>
				<StatBand.Item
					label="Speech confidence"
					value={
						stats.averageConfidence !== null
							? `${Math.round(stats.averageConfidence * 100)}%`
							: "—"
					}
					meter={
						stats.averageConfidence !== null
							? Math.round(stats.averageConfidence * 100)
							: undefined
					}
				/>
				<StatBand.Item
					label="Word timing"
					value={stats.wordTiming !== null ? `${stats.wordTiming}%` : "—"}
					meter={stats.wordTiming ?? undefined}
				/>
			</StatBand>

			{!isReady ? (
				<Text fontSize="sm" color="fg.muted">
					Transcribing now. Speaker labels and subtitle downloads show up here when it's done.
				</Text>
			) : transcript.utterances.length > 0 ? (
				<Box borderWidth="1px" borderColor="border.subtle" borderRadius="l3" overflow="hidden">
					{/* Search */}
					<Flex
						align="center"
						gap="2.5"
						px="5"
						py="2"
						borderBottomWidth="1px"
						borderColor="border.subtle"
						bg="bg.subtle"
					>
						<Box color="fg.subtle" flexShrink={0}>
							<Search size={15} aria-hidden />
						</Box>
						<Input
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Search the transcript"
							aria-label="Search the transcript"
							variant="flushed"
							borderColor="transparent"
							size="sm"
							fontSize="14px"
							flex="1"
						/>
						{searching ? (
							<Text textStyle="data" fontSize="11px" color="fg.subtle" flexShrink={0}>
								{visibleUtterances.length} of {transcript.utterances.length} lines
							</Text>
						) : null}
					</Flex>

					<Stack maxH="36rem" gap="0" overflowY="auto">
						{visibleUtterances.length === 0 ? (
							<Text px="5" py="8" fontSize="sm" color="fg.muted" textAlign="center">
								Nothing in the transcript matches "{needle}".
							</Text>
						) : (
							visibleUtterances.map((utterance) => {
								const palette = speakerPalette.get(utterance.speakerLabel) ?? "accent";
								const initials =
									utterance.speakerLabel
										.split(/\s+/)
										.map((part) => part[0])
										.join("")
										.slice(0, 2)
										.toUpperCase() || "?";
								return (
									<Flex
										key={`${utterance.index}-${utterance.startSec}`}
										gap="4"
										px="5"
										py="4"
										borderBottomWidth="1px"
										borderColor="border.subtle"
										transition="background 120ms ease"
										_hover={{ bg: "bg.subtle" }}
										_last={{ borderBottomWidth: "0" }}
									>
										<Flex
											boxSize="8"
											flexShrink={0}
											align="center"
											justify="center"
											borderRadius="full"
											bg={`${palette}.subtle`}
											color={`${palette}.fg`}
											fontSize="11px"
											fontWeight="600"
											aria-hidden="true"
										>
											{initials}
										</Flex>
										<Box minW="0" flex="1">
											<Flex gap="2.5" align="baseline" mb="1">
												<Text fontSize="13px" fontWeight="550" color="fg">
													{utterance.speakerLabel}
												</Text>
												<Text textStyle="data" fontSize="11px" color="fg.timecode">
													{formatTimecode(utterance.startSec)} – {formatTimecode(utterance.endSec)}
												</Text>
											</Flex>
											<Text fontSize="15px" lineHeight="1.7" color="fg" maxW="78ch">
												{searching ? highlight(utterance.text, needle) : utterance.text}
											</Text>
										</Box>
									</Flex>
								);
							})
						)}
					</Stack>
				</Box>
			) : (
				<Box
					as="pre"
					maxH="32rem"
					overflow="auto"
					borderRadius="l2"
					bg="bg.subtle"
					p="5"
					fontSize="13px"
					fontFamily="mono"
					lineHeight="1.6"
					whiteSpace="pre-wrap"
				>
					{transcript.text ?? "Transcript completed, but no utterances were returned."}
				</Box>
			)}
		</Stack>
	);
}
