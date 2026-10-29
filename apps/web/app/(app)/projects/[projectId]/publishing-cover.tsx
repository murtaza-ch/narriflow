"use client";
import { PublishingPreview } from "./publishing-preview";
import { type RefObject, useEffect, useRef, useState } from "react";
import {
	Box,
	chakra,
	Dialog,
	Flex,
	Portal,
	CloseButton,
	Grid,
	Image,
	Slider,
	Stack,
	Text,
} from "@chakra-ui/react";
import { Check, ImagePlus, Upload } from "lucide-react";
import { Button } from "@narriflow/ui/components/button";
import { SegmentedControl } from "@narriflow/ui/components/segmented-control";
import { Spinner } from "@narriflow/ui/components/spinner";
import { useOpenAfterMount } from "@narriflow/ui/components/use-open-after-mount";
import {
	clipAspectRatioOptions,
	type ClipAspectRatio,
	type ClipExportSnapshot,
	type SocialPlatform,
	type SocialThumbnailSelection,
} from "@narriflow/validators";
import { createIntent } from "@narriflow/api-client";
import type { ProjectPublishingApi } from "./publishing-api";

type Asset = {
	id: string;
	title: string;
	kind: string;
	contentType: string;
	sizeBytes: number;
	fingerprint: string;
	provenance: "uploaded" | "generated" | "extracted_frame";
	accessUrl: string | null;
};
/** Frames in the filmstrip: more of a narrow shape, so every shape fills the same strip at a similar height. */
const FRAME_COUNTS: Record<ClipAspectRatio, number> = {
	"9:16": 14,
	"4:5": 10,
	"1:1": 8,
	"16:9": 6,
};
const FRAME_WIDTH_PX = 120;

function formatClock(seconds: number): string {
	const safe = Math.max(0, seconds);
	const minutes = Math.floor(safe / 60);
	const rest = safe - minutes * 60;
	return `${minutes}:${rest.toFixed(1).padStart(4, "0")}`;
}

/**
 * Paints evenly spaced frames of the export onto the given canvases, one seek
 * at a time. The video is read cross-origin, which taints a canvas for reading
 * pixels back but never for drawing, so the strip is display only. A frame
 * that cannot be drawn stays a soft placeholder.
 */
function useFilmstrip(
	variantId: string,
	src: string | null,
	durationSec: number,
	count: number,
	canvases: RefObject<Array<HTMLCanvasElement | null>>,
): boolean[] {
	const [ready, setReady] = useState<boolean[]>(() =>
		Array.from({ length: count }, () => false),
	);
	const srcRef = useRef(src);
	srcRef.current = src;
	// biome-ignore lint/correctness/useExhaustiveDependencies: a refreshed signature of the same export must not repaint the strip, so the variant id stands for the source.
	useEffect(() => {
		const source = srcRef.current;
		if (!source || durationSec <= 0) return;
		let cancelled = false;
		const video = document.createElement("video");
		video.muted = true;
		video.playsInline = true;
		video.preload = "auto";
		video.src = source;
		const seek = (time: number) =>
			new Promise<void>((resolve) => {
				const finish = () => {
					clearTimeout(timer);
					video.removeEventListener("seeked", finish);
					resolve();
				};
				const timer = setTimeout(finish, 4000);
				video.addEventListener("seeked", finish);
				video.currentTime = time;
			});
		void (async () => {
			await new Promise<void>((resolve) => {
				if (video.readyState >= 1) return resolve();
				video.addEventListener("loadedmetadata", () => resolve(), { once: true });
				video.addEventListener("error", () => resolve(), { once: true });
			});
			for (let index = 0; index < count && !cancelled; index++) {
				await seek(frameTime(durationSec, index, count));
				const canvas = canvases.current?.[index];
				const context = canvas?.getContext("2d");
				if (cancelled || !canvas || !context || video.videoWidth === 0) continue;
				canvas.width = FRAME_WIDTH_PX;
				canvas.height = Math.round((FRAME_WIDTH_PX * video.videoHeight) / video.videoWidth);
				try {
					context.drawImage(video, 0, 0, canvas.width, canvas.height);
					setReady((current) => current.map((done, at) => done || at === index));
				} catch {
					// A frame that can't be drawn stays a placeholder.
				}
			}
		})();
		return () => {
			cancelled = true;
			video.removeAttribute("src");
			video.load();
		};
	}, [variantId, durationSec, count, canvases]);
	return ready;
}

/** The middle of each equal slice of the clip. */
function frameTime(durationSec: number, index: number, count: number): number {
	return (durationSec * (index + 0.5)) / count;
}

export function PublishingCover({
	api,
	projectId,
	clipId,
	platform,
	variant,
	canUpload,
	onChoose,
	onClose,
}: {
	api: Pick<ProjectPublishingApi, "visualAssets" | "requestThumbnailFrame" | "thumbnailFrame" | "presignCoverUpload" | "createCoverAsset">;
	projectId: string;
	clipId: string;
	platform: SocialPlatform;
	variant: ClipExportSnapshot["variants"][number];
	canUpload: boolean;
	onChoose(value: SocialThumbnailSelection): void;
	onClose(): void;
}) {
	const [assets, setAssets] = useState<Asset[]>([]);
	const [assetsLoaded, setAssetsLoaded] = useState(false);
	const [mode, setMode] = useState<"frame" | "image">("frame");
	const [seconds, setSeconds] = useState("0");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const video = useRef<HTMLVideoElement>(null);
	const frameCanvases = useRef<Array<HTMLCanvasElement | null>>([]);
	const mounted = useRef(true);
	const frameKey = useRef(createIntent<unknown>()).current;
	useEffect(() => {
		mounted.current = true;
		if (platform !== "tiktok")
			void api
				.visualAssets()
				.then((v) => {
					if (mounted.current) setAssets(v.assets as Asset[]);
				})
				.catch((e) => {
					if (mounted.current) setError(e.message);
				})
				.finally(() => {
					if (mounted.current) setAssetsLoaded(true);
				});
		return () => {
			mounted.current = false;
		};
	}, [platform, api]);
	function compatible(a: Asset) {
		return (
			a.kind === "image" &&
			a.provenance !== "extracted_frame" &&
			(platform !== "youtube_shorts" ||
				(["image/jpeg", "image/png"].includes(a.contentType) &&
					a.sizeBytes <= 2_000_000))
		);
	}
	function choose(a: Asset) {
		if (a.provenance !== "extracted_frame")
			onChoose({
				assetId: a.id,
				fingerprint: a.fingerprint,
				source: a.provenance,
				sourceTimeMs: null,
			});
	}
	async function frame() {
		setBusy(true);
		setError("");
		try {
			const ms = Math.round(Number(seconds) * 1000);
			let op: { id: string; status: string; asset?: { id: string; fingerprint: string } | null } = await api.requestThumbnailFrame(projectId, {
				clipId,
				exportVariantId: variant.id,
				sourceTimeMs: ms,
				idempotencyKey: frameKey.keyFor({ clipId, exportVariantId: variant.id, sourceTimeMs: ms }),
			});
			// Accepted: a lost answer is what the key protects against, and this one arrived.
			frameKey.complete();
			for (let i = 0; i < 40 && op.status !== "completed"; i++) {
				if (op.status === "failed")
					throw new Error("The frame could not be prepared. Try again.");
				await new Promise((r) => setTimeout(r, 1500));
				if (!mounted.current) return;
				op = await api.thumbnailFrame(projectId, op.id);
			}
			if (!op.asset)
				throw new Error("The frame is still preparing. Try again shortly.");
			if (mounted.current)
				onChoose({
					assetId: op.asset.id,
					fingerprint: op.asset.fingerprint,
					source: "extracted_frame",
					sourceTimeMs: ms,
				});
		} catch (e) {
			if (mounted.current)
				setError(e instanceof Error ? e.message : "Could not prepare cover.");
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	async function upload(file: File | undefined) {
		if (!file) return;
		setBusy(true);
		setError("");
		try {
			if (
				!compatible({
					kind: "image",
					contentType: file.type,
					sizeBytes: file.size,
					provenance: "uploaded",
				} as Asset) ||
				!["image/jpeg", "image/png", "image/webp"].includes(file.type)
			)
				throw new Error(
					"Choose a compatible image. YouTube covers must be JPEG or PNG, up to 2 MB.",
				);
			const digest = await crypto.subtle.digest(
				"SHA-256",
				await file.arrayBuffer(),
			);
			const fingerprint = [...new Uint8Array(digest)]
				.map((v) => v.toString(16).padStart(2, "0"))
				.join("");
			const prepared = await api.presignCoverUpload({
				contentType: file.type,
				sizeBytes: file.size,
			});
			const result = await fetch(prepared.uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": file.type },
				body: file,
			});
			if (!result.ok) throw new Error("The image could not be uploaded.");
			const asset = (await api.createCoverAsset({
				key: prepared.key,
				// Checked against the accepted types above.
				contentType: file.type as "image/jpeg" | "image/png" | "image/webp",
				sizeBytes: file.size,
				fingerprint,
				title: file.name.slice(0, 120),
				provenance: "uploaded",
			})) as Asset;
			if (mounted.current) choose(asset);
		} catch (e) {
			if (mounted.current)
				setError(e instanceof Error ? e.message : "Could not upload cover.");
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	const durationSec = variant.durationSec ?? 0;
	const secondsValue = Number(seconds);
	const secondsValid =
		Number.isFinite(secondsValue) &&
		secondsValue >= 0 &&
		secondsValue <= durationSec;
	const ratioOption = clipAspectRatioOptions.find(
		(option) => option.value === variant.aspectRatio,
	);
	const ratio = ratioOption ? ratioOption.iconW / ratioOption.iconH : 9 / 16;
	const frameCount = FRAME_COUNTS[variant.aspectRatio] ?? 8;
	const frames = useFilmstrip(
		variant.id,
		variant.previewUrl ?? null,
		durationSec,
		frameCount,
		frameCanvases,
	);
	const selectedFrame =
		durationSec > 0 && secondsValid
			? Math.min(
					frameCount - 1,
					Math.floor((secondsValue / durationSec) * frameCount),
				)
			: -1;
	function pickTime(value: number) {
		// Round down to the tenth, never past the end: rounding 12.37 up to
		// 12.4 would land beyond a 12.37s clip and reset the choice.
		const time = Math.min(durationSec, Math.floor(value * 10) / 10);
		setSeconds(String(time));
		if (video.current) video.current.currentTime = time;
	}
	const showImages = platform !== "tiktok" && mode === "image";
	// This dialog mounts already open; see useOpenAfterMount.
	const open = useOpenAfterMount(true);
	return (
		<Dialog.Root
			open={open}
			onOpenChange={(d) => {
				if (!d.open) onClose();
			}}
			size="lg"
		>
			<Portal>
				<Dialog.Backdrop />
				<Dialog.Positioner>
					<Dialog.Content>
						<Dialog.Header>
							<Dialog.Title fontSize="18px" fontWeight="500">
								Choose a cover
							</Dialog.Title>
						</Dialog.Header>
						<Dialog.CloseTrigger asChild>
							<CloseButton size="sm" borderRadius="full" />
						</Dialog.CloseTrigger>
						<Dialog.Body>
							<Stack gap="5">
								{platform !== "tiktok" && (
									<SegmentedControl
										aria-label="Cover source"
										w="full"
										css={{ "& [data-part=item]": { flex: 1, justifyContent: "center" } }}
										items={[
											{ label: "Video frame", value: "frame" },
											{ label: "Image", value: "image" },
										]}
										value={mode}
										onValueChange={(value) => setMode(value as typeof mode)}
									/>
								)}

								{/* Hidden, not unmounted, in image mode: the filmstrip's drawn frames and the preview's position survive a round trip. */}
									<Stack gap="4" display={showImages ? "none" : "flex"}>
										{variant.previewUrl && (
											<Flex
												justify="center"
												bg="studio.canvas"
												borderRadius="l2"
												overflow="hidden"
											>
												<Box h="240px" maxW="full" aspectRatio={ratio}>
													<PublishingPreview
														key={variant.id}
														ref={video}
														src={variant.previewUrl}
														muted
														playsInline
														preload="auto"
														aria-label="Cover frame preview"
														style={{
															width: "100%",
															height: "100%",
															objectFit: "contain",
															display: "block",
														}}
													/>
												</Box>
											</Flex>
										)}

										{variant.previewUrl && durationSec > 0 && (
											<Grid
												templateColumns={`repeat(${frameCount}, minmax(0, 1fr))`}
												gap="1.5"
												role="group"
												aria-label="Frames from the video"
											>
												{Array.from({ length: frameCount }, (_, index) => {
													const time = frameTime(durationSec, index, frameCount);
													const selected = index === selectedFrame;
													return (
														<chakra.button
															key={index}
															type="button"
															aria-label={`Frame at ${time.toFixed(1)} seconds`}
															aria-pressed={selected}
															disabled={busy}
															onClick={() => pickTime(time)}
															position="relative"
															display="block"
															aspectRatio={ratio}
															minW="0"
															overflow="hidden"
															borderRadius="l1"
															bg="bg.muted"
															cursor="pointer"
															opacity={selected ? 1 : 0.78}
															transition="opacity 120ms ease"
															_hover={{ opacity: 1 }}
															_disabled={{ cursor: "not-allowed", opacity: 0.5 }}
														>
															<chakra.canvas
																ref={(element: HTMLCanvasElement | null) => {
																	frameCanvases.current[index] = element;
																}}
																width={FRAME_WIDTH_PX}
																height={Math.round(FRAME_WIDTH_PX / ratio)}
																aria-hidden="true"
																position="absolute"
																inset="0"
																w="full"
																h="full"
																objectFit="cover"
																opacity={frames[index] ? 1 : 0}
																transition="opacity 200ms ease"
															/>
															{selected && (
																<>
																	<Box
																		aria-hidden="true"
																		position="absolute"
																		inset="0"
																		bg="accent.solid"
																		opacity={0.28}
																	/>
																	<Flex
																		aria-hidden="true"
																		position="absolute"
																		bottom="1"
																		insetEnd="1"
																		boxSize="4"
																		align="center"
																		justify="center"
																		borderRadius="full"
																		bg="accent.solid"
																		color="accent.contrast"
																	>
																		<Check size={10} strokeWidth={3.5} />
																	</Flex>
																</>
															)}
														</chakra.button>
													);
												})}
											</Grid>
										)}

										<Stack gap="2">
											<Flex align="baseline" justify="space-between" gap="3">
												<Text textStyle="eyebrow" color="fg.muted">
													Frame
												</Text>
												<Text
													fontSize="13px"
													color="fg"
													fontVariantNumeric="tabular-nums"
												>
													{formatClock(secondsValid ? secondsValue : 0)}
													<Text as="span" color="fg.subtle">
														{" "}
														/ {formatClock(durationSec)}
													</Text>
												</Text>
											</Flex>
											<Slider.Root
												aria-label={["Frame time in seconds"]}
												value={[secondsValid ? secondsValue : 0]}
												min={0}
												max={Math.max(durationSec, 0.1)}
												step={0.1}
												size="sm"
												colorPalette="accent"
												disabled={busy || durationSec <= 0}
												onValueChange={(details) =>
													pickTime(details.value[0] ?? 0)
												}
											>
												<Slider.Control>
													<Slider.Track>
														<Slider.Range />
													</Slider.Track>
													<Slider.Thumbs />
												</Slider.Control>
											</Slider.Root>
										</Stack>
									</Stack>

								{showImages && (
									<Stack gap="4">
										{canUpload && (
											<chakra.label
												display="flex"
												alignItems="center"
												gap="3"
												px="4"
												py="3.5"
												borderRadius="l2"
												bg="bg.soft"
												cursor={busy ? "not-allowed" : "pointer"}
												opacity={busy ? 0.6 : 1}
												transition="background-color 120ms ease"
												_hover={busy ? undefined : { bg: "bg.softHover" }}
												_focusWithin={{
													outline: "2px solid",
													outlineColor: "accent.solid",
												}}
											>
												<Flex
													boxSize="9"
													flexShrink={0}
													align="center"
													justify="center"
													borderRadius="full"
													bg="bg.muted"
													color="fg.muted"
													aria-hidden="true"
												>
													{busy ? <Spinner size="xs" /> : <Upload size={16} />}
												</Flex>
												<Box flex="1" minW="0">
													<Text fontSize="14px" fontWeight="500">
														Upload image
													</Text>
													<Text fontSize="12px" color="fg.muted">
														{platform === "youtube_shorts"
															? "JPEG or PNG, up to 2 MB"
															: "JPEG, PNG or WebP"}
													</Text>
												</Box>
												<chakra.input
													type="file"
													srOnly
													accept={
														platform === "youtube_shorts"
															? "image/jpeg,image/png"
															: "image/jpeg,image/png,image/webp"
													}
													disabled={busy}
													onChange={(e) => void upload(e.target.files?.[0])}
												/>
											</chakra.label>
										)}
										{assets.filter(compatible).length > 0 ? (
											<Grid templateColumns="repeat(4, minmax(0, 1fr))" gap="2">
												{assets.filter(compatible).map((asset) => (
													<chakra.button
														key={asset.id}
														type="button"
														disabled={busy}
														onClick={() => choose(asset)}
														display="flex"
														flexDirection="column"
														gap="1.5"
														p="1.5"
														minW="0"
														borderRadius="l2"
														bg="bg.soft"
														textAlign="start"
														cursor="pointer"
														transition="background-color 120ms ease"
														_hover={{ bg: "bg.softHover" }}
														_disabled={{ cursor: "not-allowed", opacity: 0.5 }}
													>
														<Box
															aspectRatio={1}
															borderRadius="l1"
															overflow="hidden"
															bg="bg.muted"
														>
															{asset.accessUrl && (
																<Image
																	src={asset.accessUrl}
																	alt={asset.title}
																	w="full"
																	h="full"
																	objectFit="cover"
																/>
															)}
														</Box>
														<Text
															truncate
															fontSize="12px"
															color="fg.muted"
															px="0.5"
														>
															{asset.title}
														</Text>
													</chakra.button>
												))}
											</Grid>
										) : assetsLoaded ? (
											<Flex
												direction="column"
												align="center"
												gap="2"
												py="6"
												color="fg.subtle"
												textAlign="center"
											>
												<ImagePlus size={20} aria-hidden="true" />
												<Text fontSize="13px">
													{canUpload
														? "No images yet. Upload one to use as a cover."
														: "No compatible images in your library."}
												</Text>
											</Flex>
										) : null}
									</Stack>
								)}

								{error && (
									<Text
										role="alert"
										fontSize="13px"
										color="danger.fg"
										px="3"
										py="2.5"
										borderRadius="l2"
										bg="danger.subtle"
									>
										{error}
									</Text>
								)}
							</Stack>
						</Dialog.Body>
						<Dialog.Footer>
							<Dialog.ActionTrigger asChild>
								<Button variant="ghost">Close</Button>
							</Dialog.ActionTrigger>
							{!showImages && (
								<Button
									disabled={busy || !secondsValid}
									onClick={() => void frame()}
								>
									{busy ? <Spinner size="xs" borderTopColor="accent.contrast" /> : null}
									{busy ? "Preparing…" : "Use this frame"}
								</Button>
							)}
						</Dialog.Footer>
					</Dialog.Content>
				</Dialog.Positioner>
			</Portal>
		</Dialog.Root>
	);
}
