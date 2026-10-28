"use client";

import {
	memo,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	type KeyboardEvent,
	type ReactNode,
} from "react";
import Link from "next/link";
import {
	AlertTriangle,
	Check,
	ChevronDown,
	Copy,
	Download,
	FileText,
	Search,
	X,
} from "lucide-react";
import { Button, IconButton } from "@narriflow/ui/components/button";
import { ActionMenu } from "@narriflow/ui/components/menu";
import { EmptyState } from "@narriflow/ui/components/empty-state";
import { Spinner } from "@narriflow/ui/components/spinner";
import { StatusBadge } from "@narriflow/ui/components/status-badge";
import { userErrorMessage, type TranscriptSnapshot } from "@narriflow/validators";
import { Box, Flex, Grid, Input, Stack, Text } from "@chakra-ui/react";
import { formatDuration, formatTimecode } from "@/lib/format";
import { PanelHeader } from "./panel-header";
import { groupTranscriptParagraphs, type TranscriptParagraph } from "./transcript-paragraphs";

/**
 * Speakers keep one categorical tint each, in order of first appearance —
 * the accent first, then hues that carry no status meaning (never danger or
 * warning, which read as errors).
 */
const SPEAKER_PALETTES = ["accent", "purple", "orange", "pink", "cyan"] as const;

interface SpeakerStyle {
	palette: (typeof SPEAKER_PALETTES)[number];
	initials: string;
}

const DOWNLOADS = [
	{ format: "txt", label: "Text (.txt)" },
	{ format: "srt", label: "SubRip (.srt)" },
	{ format: "vtt", label: "WebVTT (.vtt)" },
] as const;

/** Reading column: timecode gutter, then text at a comfortable measure. */
const GUTTER = "72px";
const COLUMN_GAP = "16px";
const ROW_PADDING_X = "12px";

function escapeRegExp(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function initialsOf(label: string) {
	return (
		label
			.split(/\s+/)
			.map((part) => part[0])
			.join("")
			.slice(0, 2)
			.toUpperCase() || "?"
	);
}

function Stat({ label, children }: { label: string; children: ReactNode }) {
	return (
		<Stack gap="0.5" minW="0">
			<Text fontSize="12px" color="fg.muted">
				{label}
			</Text>
			<Flex align="center" gap="2.5" minH="7">
				{children}
			</Flex>
		</Stack>
	);
}

function StatValue({ children }: { children: ReactNode }) {
	return (
		<Text
			fontSize="20px"
			fontWeight="500"
			lineHeight="1.2"
			fontVariantNumeric="tabular-nums"
			color="fg"
		>
			{children}
		</Text>
	);
}

function MiniMeter({ value, label }: { value: number; label: string }) {
	const clamped = Math.min(100, Math.max(0, value));
	return (
		<Box
			role="meter"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={clamped}
			flex="1"
			minW="10"
			maxW="16"
			h="6px"
			bg="bg.soft"
			borderRadius="full"
			overflow="hidden"
		>
			<Box h="full" width={`${clamped}%`} bg="accent.solid" borderRadius="full" />
		</Box>
	);
}

/** A soft, centred note for states with no transcript text to show. */
function SoftNote({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
	return (
		<Flex
			direction="column"
			align="center"
			gap="2"
			bg="bg.subtle"
			borderRadius="l3"
			px="6"
			py="12"
			textAlign="center"
		>
			{icon}
			<Text fontSize="15px" fontWeight="500" color="fg">
				{title}
			</Text>
			{hint ? (
				<Text fontSize="13px" color="fg.muted">
					{hint}
				</Text>
			) : null}
		</Flex>
	);
}

/**
 * One paragraph. Memoised so a keystroke in the search field, or the copy
 * confirmation on a single row, never re-renders the other few hundred.
 * `parts` is the paragraph text split around search hits (odd indexes are hits).
 */
const ParagraphRow = memo(function ParagraphRow({
	paragraph,
	speaker,
	parts,
}: {
	paragraph: TranscriptParagraph;
	speaker: SpeakerStyle;
	parts: string[] | null;
}) {
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<number | undefined>(undefined);

	useEffect(() => () => window.clearTimeout(resetTimer.current), []);

	const copy = useCallback(async () => {
		try {
			await navigator.clipboard.writeText(paragraph.text);
		} catch {
			return;
		}
		setCopied(true);
		window.clearTimeout(resetTimer.current);
		resetTimer.current = window.setTimeout(() => setCopied(false), 1500);
	}, [paragraph.text]);

	return (
		<Box mt={paragraph.newSpeaker ? "3" : "0"} _first={{ mt: "0" }}>
			{paragraph.newSpeaker ? (
				<Flex
					align="center"
					gap="2"
					mb="1"
					ps={{ base: ROW_PADDING_X, md: `calc(${ROW_PADDING_X} + ${GUTTER} + ${COLUMN_GAP})` }}
				>
					<Flex
						boxSize="6"
						flexShrink={0}
						align="center"
						justify="center"
						borderRadius="full"
						bg={`${speaker.palette}.subtle`}
						color={`${speaker.palette}.fg`}
						fontSize="10px"
						fontWeight="600"
						aria-hidden="true"
					>
						{speaker.initials}
					</Flex>
					<Text fontSize="13px" fontWeight="550" color="fg">
						{paragraph.speakerLabel}
					</Text>
				</Flex>
			) : null}
			<Grid
				className="group"
				templateColumns={{ base: "minmax(0, 1fr)", md: `${GUTTER} minmax(0, 1fr)` }}
				columnGap={COLUMN_GAP}
				rowGap="0.5"
				px={ROW_PADDING_X}
				py="1.5"
				borderRadius="l2"
				transition="background 120ms ease"
				_hover={{ bg: "bg.subtle" }}
			>
				<Text textStyle="data" fontSize="12px" lineHeight="26px" color="fg.subtle">
					{formatTimecode(paragraph.startSec)}
				</Text>
				<Flex align="flex-start" gap="2" minW="0">
					<Text flex="1" minW="0" maxW="72ch" fontSize="15px" lineHeight="1.75" color="fg">
						{parts
							? parts.map((part, index) =>
									index % 2 === 1 ? <mark key={index}>{part}</mark> : part,
								)
							: paragraph.text}
					</Text>
					<IconButton
						type="button"
						size="xs"
						variant="ghost"
						aria-label={copied ? "Copied" : "Copy paragraph"}
						onClick={() => void copy()}
						color={copied ? "accent.fg" : "fg.muted"}
						opacity={copied ? 1 : { base: 1, md: 0 }}
						_groupHover={{ opacity: 1 }}
						_focusVisible={{ opacity: 1 }}
						transition="opacity 120ms ease"
					>
						{copied ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}
					</IconButton>
				</Flex>
			</Grid>
		</Box>
	);
});

export function TranscriptPanel({
	projectId,
	transcript,
}: {
	projectId: string;
	transcript: TranscriptSnapshot | null;
}) {
	const [query, setQuery] = useState("");
	/** The hit Enter last jumped to; -1 until the first jump. */
	const [activeHit, setActiveHit] = useState(-1);
	const [jump, setJump] = useState(0);
	const bodyRef = useRef<HTMLDivElement>(null);
	const needle = query.trim();
	const searching = needle.length >= 2;

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

	const speakers = useMemo(() => {
		const map = new Map<string, SpeakerStyle>();
		for (const utterance of transcript?.utterances ?? []) {
			if (!map.has(utterance.speakerLabel)) {
				map.set(utterance.speakerLabel, {
					palette: SPEAKER_PALETTES[map.size % SPEAKER_PALETTES.length]!,
					initials: initialsOf(utterance.speakerLabel),
				});
			}
		}
		return map;
	}, [transcript]);

	const paragraphs = useMemo(
		() => groupTranscriptParagraphs(transcript?.utterances ?? []),
		[transcript],
	);

	// Each paragraph split around the search hits, so the count shown and the
	// highlights drawn come from one pass and cannot disagree.
	const hits = useMemo(() => {
		if (!searching) return null;
		const pattern = new RegExp(`(${escapeRegExp(needle)})`, "i");
		let total = 0;
		const parts = paragraphs.map((paragraph) => {
			const split = paragraph.text.split(pattern);
			total += (split.length - 1) / 2;
			return split.length > 1 ? split : null;
		});
		return { parts, total };
	}, [paragraphs, needle, searching]);

	// The active hit is a data attribute set on the DOM, not React state per
	// match, so jumping between hits re-renders nothing. Every query change
	// resets `activeHit` to -1, which clears the previous attribute here.
	// biome-ignore lint/correctness/useExhaustiveDependencies: `jump` re-runs this on every Enter, so a lone match scrolls back into view.
	useEffect(() => {
		const root = bodyRef.current;
		if (!root) return;
		for (const element of root.querySelectorAll("mark[data-active]")) {
			element.removeAttribute("data-active");
		}
		if (activeHit < 0) return;
		const element = root.querySelectorAll("mark")[activeHit];
		if (!element) return;
		element.setAttribute("data-active", "");
		element.scrollIntoView({ block: "center" });
	}, [activeHit, jump]);

	function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
		if (event.key === "Escape") {
			setQuery("");
			setActiveHit(-1);
			return;
		}
		// Enter that confirms an IME composition (Japanese, Chinese…) isn't a jump.
		if (event.nativeEvent.isComposing) return;
		if (event.key !== "Enter" || !hits || hits.total === 0) return;
		event.preventDefault();
		setJump((count) => count + 1);
		const step = event.shiftKey ? -1 : 1;
		setActiveHit((current) =>
			current < 0
				? step > 0
					? 0
					: hits.total - 1
				: (current + step + hits.total) % hits.total,
		);
	}

	if (!transcript || !stats) {
		return (
			<EmptyState
				icon={<FileText size={22} aria-hidden />}
				title="No transcript yet"
				description="It shows up here once the video is transcribed."
				action={
					<Button asChild size="sm" variant="subtle">
						<Link href={`/projects/${projectId}`}>Go to clips</Link>
					</Button>
				}
			/>
		);
	}

	const isReady = transcript.status === "completed";
	const pending = transcript.status === "queued" || transcript.status === "processing";
	const failure = transcript.errorCode
		? userErrorMessage(transcript.errorCode)
		: transcript.status === "failed"
			? "Transcription failed."
			: null;
	const hitCount = hits?.total ?? 0;

	return (
		<Stack gap="5">
			<PanelHeader
				icon={<FileText size={20} />}
				title="Transcript"
				badge={
					isReady ? null : (
						<StatusBadge status={transcript.status as "processing" | "failed"} />
					)
				}
				description="Search, copy and download the full text."
				actions={
					isReady ? (
						<ActionMenu
							ariaLabel="Download transcript"
							trigger={
								<Button size="sm" variant="subtle">
									<Download size={14} aria-hidden />
									Download
									<ChevronDown size={14} aria-hidden />
								</Button>
							}
							items={DOWNLOADS.map(({ format, label }) => ({
								value: format,
								label,
								onSelect: () =>
									window.location.assign(
										`/api/projects/${projectId}/transcript/export?format=${format}`,
									),
							}))}
						/>
					) : null
				}
			/>

			{failure ? (
				<Flex
					role="alert"
					align="center"
					gap="2"
					bg="danger.subtle"
					color="danger.fg"
					borderRadius="l2"
					px="3.5"
					py="2.5"
				>
					<AlertTriangle size={14} aria-hidden />
					<Text fontSize="13px">{failure}</Text>
				</Flex>
			) : null}

			{pending ? (
				<SoftNote
					icon={<Spinner size="md" />}
					title="Transcribing now"
					hint="The text and downloads appear here when it's ready."
				/>
			) : null}

			{isReady && paragraphs.length === 0 ? (
				transcript.text ? (
					<Text
						bg="bg.subtle"
						borderRadius="l3"
						p="5"
						fontSize="15px"
						lineHeight="1.75"
						whiteSpace="pre-wrap"
					>
						{transcript.text}
					</Text>
				) : (
					<SoftNote title="This transcript has no text." />
				)
			) : null}

			{isReady && paragraphs.length > 0 ? (
				<>
					<Box
						display="grid"
						gridTemplateColumns="repeat(auto-fit, minmax(7rem, 1fr))"
						columnGap="6"
						rowGap="4"
						bg="bg.subtle"
						borderRadius="l3"
						px={{ base: "4", md: "5" }}
						py="4"
					>
						<Stat label="Language">
							<StatValue>{(transcript.languageCode ?? "—").toUpperCase()}</StatValue>
							{typeof transcript.languageConfidence === "number" ? (
								<Text
									fontSize="12px"
									fontVariantNumeric="tabular-nums"
									color="fg.subtle"
									title="Language detection confidence"
								>
									{Math.round(transcript.languageConfidence * 100)}%
								</Text>
							) : null}
						</Stat>
						<Stat label="Speakers">
							<StatValue>{transcript.speakerCount ?? speakers.size}</StatValue>
						</Stat>
						<Stat label="Words">
							<StatValue>{stats.wordCount.toLocaleString()}</StatValue>
						</Stat>
						<Stat label="Duration">
							<StatValue>
								{stats.durationSec !== null ? formatDuration(stats.durationSec) : "—"}
							</StatValue>
						</Stat>
						<Stat label="Speech confidence">
							<StatValue>
								{stats.averageConfidence !== null
									? `${Math.round(stats.averageConfidence * 100)}%`
									: "—"}
							</StatValue>
							{stats.averageConfidence !== null ? (
								<MiniMeter
									value={Math.round(stats.averageConfidence * 100)}
									label="Speech confidence"
								/>
							) : null}
						</Stat>
						<Stat label="Word timing">
							<StatValue>{stats.wordTiming !== null ? `${stats.wordTiming}%` : "—"}</StatValue>
							{stats.wordTiming !== null ? (
								<MiniMeter value={stats.wordTiming} label="Word timing" />
							) : null}
						</Stat>
					</Box>

					{/* Stays in view while Enter walks the matches down a long transcript. */}
					<Box position="sticky" top="0" zIndex="2" bg="bg" py="2" mt="-2">
					<Box position="relative" maxW="30rem">
						<Box
							position="absolute"
							insetStart="3"
							top="50%"
							transform="translateY(-50%)"
							color="fg.subtle"
							pointerEvents="none"
						>
							<Search size={15} aria-hidden />
						</Box>
						<Input
							value={query}
							onChange={(event) => {
								setQuery(event.target.value);
								setActiveHit(-1);
							}}
							onKeyDown={onSearchKeyDown}
							placeholder="Search the transcript"
							aria-label="Search the transcript"
							size="sm"
							fontSize="14px"
							ps="9"
							pe={query ? "32" : "3"}
						/>
						{query ? (
							<Flex
								position="absolute"
								insetEnd="1.5"
								top="50%"
								transform="translateY(-50%)"
								align="center"
								gap="1"
							>
								<Text
									role="status"
									fontSize="12px"
									fontVariantNumeric="tabular-nums"
									color="fg.subtle"
									whiteSpace="nowrap"
								>
									{!searching
										? ""
										: hitCount === 0
											? "No matches"
											: activeHit >= 0
												? `${activeHit + 1} of ${hitCount}`
												: `${hitCount} ${hitCount === 1 ? "match" : "matches"}`}
								</Text>
								<IconButton
									type="button"
									size="2xs"
									variant="ghost"
									aria-label="Clear search"
									color="fg.muted"
									onClick={() => {
										setQuery("");
										setActiveHit(-1);
									}}
								>
									<X size={13} aria-hidden />
								</IconButton>
							</Flex>
						) : null}
					</Box>
					</Box>

					<Stack
						ref={bodyRef}
						gap="1"
						css={{
							"& mark": {
								background: "var(--chakra-colors-accent-muted)",
								color: "inherit",
								borderRadius: "3px",
								padding: "0 1px",
							},
							"& mark[data-active]": {
								background: "var(--chakra-colors-accent-solid)",
								color: "var(--chakra-colors-accent-contrast)",
							},
						}}
					>
						{paragraphs.map((paragraph, index) => (
							<ParagraphRow
								key={paragraph.key}
								paragraph={paragraph}
								speaker={
									speakers.get(paragraph.speakerLabel) ?? { palette: "accent", initials: "?" }
								}
								parts={hits?.parts[index] ?? null}
							/>
						))}
					</Stack>
				</>
			) : null}
		</Stack>
	);
}
