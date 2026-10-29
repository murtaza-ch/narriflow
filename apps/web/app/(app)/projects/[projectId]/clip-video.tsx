"use client";

import { Box, Flex } from "@chakra-ui/react";
import { Pause, Play } from "lucide-react";
import { type SyntheticEvent, useEffect, useRef, useState } from "react";
import { formatDuration } from "@/lib/format";

/**
 * Preview player for one clip segment.
 *
 * Only rows at or near the viewport are allowed to touch the network. A
 * project renders every clip at once (10 by default), and each preview is a
 * cross-origin R2 object, so `preload="metadata"` on all of them put ten
 * simultaneous range requests in flight on mount — they contend, none of them
 * paints a first frame, and the wells sit empty exactly as long as the slowest
 * one takes. Loading two or three at a time instead means the visible clips
 * paint promptly and offscreen ones cost nothing until scrolled to.
 *
 * The `#t=` media fragment is what actually puts a frame on screen: the
 * browser seeks to the clip's in-point while loading metadata, natively,
 * instead of waiting for `loadedmetadata` to round-trip through React. The
 * handlers below stay as the fallback for browsers that ignore the fragment,
 * and to loop back to the in-point at the end.
 */
export function ClipVideo({
	src,
	startSec,
	endSec,
	onMediaError,
}: {
	src: string;
	startSec: number;
	endSec: number;
	/** The player could not load its grant (expired or revoked): ask for a fresh one. */
	onMediaError: () => void;
}) {
	const containerRef = useRef<HTMLDivElement>(null);
	const videoRef = useRef<HTMLVideoElement>(null);
	const [shouldLoad, setShouldLoad] = useState(false);
	const [playing, setPlaying] = useState(false);
	// Seconds into the clip, for the countdown on the duration chip.
	const [elapsed, setElapsed] = useState(0);
	const clipDuration = Math.max(0, endSec - startSec);
	// A renewed grant never swaps under a playing clip; it lands on pause, or at once after a media failure.
	const [served, setServed] = useState(src);
	const [failed, setFailed] = useState(false);
	useEffect(() => {
		if (src === served || (playing && !failed)) return;
		setServed(src);
		setFailed(false);
	}, [src, served, playing, failed]);

	function togglePlay() {
		const video = videoRef.current;
		if (!video) return;
		if (video.paused) {
			if (video.currentTime < startSec || video.currentTime >= endSec) video.currentTime = startSec;
			void video.play();
		} else {
			video.pause();
		}
	}

	useEffect(() => {
		const element = containerRef.current;
		if (!element) return;

		// No IntersectionObserver (or SSR-hydrated older browser) — fall back to
		// the previous always-load behaviour rather than showing nothing.
		if (typeof IntersectionObserver === "undefined") {
			setShouldLoad(true);
			return;
		}

		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((entry) => entry.isIntersecting)) return;
				setShouldLoad(true);
				observer.disconnect();
			},
			// Start a row early so scrolling lands on a painted frame, not a gap.
			{ rootMargin: "300px" },
		);

		observer.observe(element);
		return () => observer.disconnect();
	}, []);

	return (
		// Custom controls only: one play/pause button and the duration, which
		// counts down while the clip plays. A click anywhere on the video toggles it.
		<Box ref={containerRef} w="full" h="full" position="relative" className="group" cursor="pointer" onClick={togglePlay}>
			{/* biome-ignore lint/a11y/useMediaCaption: preview player for a clip segment; no caption/VTT source is available in this component. */}
			<video
				ref={videoRef}
				src={`${served}#t=${startSec},${endSec}`}
				playsInline
				disablePictureInPicture
				preload={shouldLoad ? "metadata" : "none"}
				onPlay={() => setPlaying(true)}
				onPause={() => setPlaying(false)}
				onError={() => {
					setFailed(true);
					onMediaError();
				}}
				style={{
					width: "100%",
					height: "100%",
					display: "block",
					objectFit: "contain",
				}}
				onLoadedMetadata={(event: SyntheticEvent<HTMLVideoElement>) => {
					const video = event.currentTarget;
					if (video.currentTime < startSec) video.currentTime = startSec;
				}}
				onTimeUpdate={(event: SyntheticEvent<HTMLVideoElement>) => {
					const video = event.currentTarget;
					if (video.currentTime >= endSec) {
						video.pause();
						video.currentTime = startSec;
					}
					setElapsed(Math.min(clipDuration, Math.max(0, video.currentTime - startSec)));
				}}
			/>
			<Flex
				as="button"
				aria-label={playing ? "Pause clip" : "Play clip"}
				position="absolute"
				top="50%"
				left="50%"
				transform="translate(-50%, -50%)"
				boxSize="12"
				align="center"
				justify="center"
				borderRadius="full"
				bg="studio.scrimStrong"
				color="white"
				border="none"
				cursor="pointer"
				// Hidden while playing until the pointer is over the clip.
				opacity={playing ? 0 : 1}
				transition="opacity 150ms ease, transform 150ms ease"
				_groupHover={{ opacity: 1 }}
				_focusVisible={{ opacity: 1, outline: "2px solid", outlineColor: "accent.solid", outlineOffset: "2px" }}
				onClick={(event: React.MouseEvent) => {
					event.stopPropagation();
					togglePlay();
				}}
			>
				{playing ? <Pause size={18} fill="currentColor" /> : <Play size={18} fill="currentColor" style={{ marginLeft: 2 }} />}
			</Flex>
			<Box
				position="absolute"
				bottom="1.5"
				insetEnd="1.5"
				px="1.5"
				py="0.5"
				borderRadius="l1"
				bg="studio.scrim"
				color="studio.timecode"
				textStyle="data"
				fontSize="11px"
				lineHeight="1.4"
				pointerEvents="none"
			>
				{formatDuration(playing || elapsed > 0 ? clipDuration - elapsed : clipDuration)}
			</Box>
		</Box>
	);
}
