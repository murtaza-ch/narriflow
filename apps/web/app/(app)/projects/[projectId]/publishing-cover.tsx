"use client";
import { PublishingPreview } from "./publishing-preview";
import { useEffect, useRef, useState } from "react";
import {
	Dialog,
	Portal,
	CloseButton,
	Field,
	Grid,
	Stack,
	Text,
	Image,
} from "@chakra-ui/react";
import { Button } from "@narriflow/ui/components/button";
import { Input } from "@narriflow/ui/components/input";
import type {
	ClipExportSnapshot,
	SocialPlatform,
	SocialThumbnailSelection,
} from "@narriflow/validators";
import { publishingRequest } from "./publishing-draft";
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
export function PublishingCover({
	projectId,
	clipId,
	platform,
	variant,
	canUpload,
	onChoose,
	onClose,
}: {
	projectId: string;
	clipId: string;
	platform: SocialPlatform;
	variant: ClipExportSnapshot["variants"][number];
	canUpload: boolean;
	onChoose(value: SocialThumbnailSelection): void;
	onClose(): void;
}) {
	const [assets, setAssets] = useState<Asset[]>([]);
	const [seconds, setSeconds] = useState("0");
	const [busy, setBusy] = useState(false);
	const [error, setError] = useState("");
	const video = useRef<HTMLVideoElement>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		if (platform !== "tiktok")
			void publishingRequest<{ assets: Asset[] }>("/api/visual-assets")
				.then((v) => {
					if (mounted.current) setAssets(v.assets);
				})
				.catch((e) => {
					if (mounted.current) setError(e.message);
				});
		return () => {
			mounted.current = false;
		};
	}, [platform]);
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
			let op = await publishingRequest<{
				id: string;
				status: string;
				asset?: { id: string; fingerprint: string };
			}>(`/api/projects/${projectId}/thumbnail-frames`, {
				clipId,
				exportVariantId: variant.id,
				sourceTimeMs: ms,
				idempotencyKey: crypto.randomUUID(),
			});
			for (let i = 0; i < 40 && op.status !== "completed"; i++) {
				if (op.status === "failed")
					throw new Error("The frame could not be prepared. Try again.");
				await new Promise((r) => setTimeout(r, 1500));
				if (!mounted.current) return;
				op = await publishingRequest(
					`/api/projects/${projectId}/thumbnail-frames/${op.id}`,
				);
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
			const prepared = await publishingRequest<{
				key: string;
				uploadUrl: string;
			}>("/api/visual-assets/presign-upload", {
				contentType: file.type,
				sizeBytes: file.size,
			});
			const result = await fetch(prepared.uploadUrl, {
				method: "PUT",
				headers: { "Content-Type": file.type },
				body: file,
			});
			if (!result.ok) throw new Error("The image could not be uploaded.");
			const asset = await publishingRequest<Asset>("/api/visual-assets", {
				key: prepared.key,
				contentType: file.type,
				sizeBytes: file.size,
				fingerprint,
				title: file.name.slice(0, 120),
				provenance: "uploaded",
			});
			if (mounted.current) choose(asset);
		} catch (e) {
			if (mounted.current)
				setError(e instanceof Error ? e.message : "Could not upload cover.");
		} finally {
			if (mounted.current) setBusy(false);
		}
	}
	return (
		<Dialog.Root
			open
			onOpenChange={(d) => {
				if (!d.open) onClose();
			}}
			size="lg"
		>
			<Portal>
				<Dialog.Backdrop />
				<Dialog.Positioner>
					<Dialog.Content bg="bg.panel">
						<Dialog.Header>
							<Dialog.Title>Choose a cover</Dialog.Title>
						</Dialog.Header>
						<Dialog.CloseTrigger asChild>
							<CloseButton size="sm" />
						</Dialog.CloseTrigger>
						<Dialog.Body>
							<Stack gap="4">
								{variant.previewUrl && (
									<PublishingPreview key={variant.id}
										ref={video}
										src={variant.previewUrl}
										controls
										muted
										style={{ width: "100%", maxHeight: 280 }}
									/>
								)}
								<Field.Root>
									<Field.Label>Video frame, seconds</Field.Label>
									<Input
										type="number"
										min="0"
										max={variant.durationSec ?? 0}
										step="0.1"
										value={seconds}
										onChange={(e) => {
											setSeconds(e.target.value);
											if (video.current)
												video.current.currentTime = Number(e.target.value);
										}}
									/>
								</Field.Root>
								<Button
									disabled={
										busy ||
										!Number.isFinite(Number(seconds)) ||
										Number(seconds) < 0 ||
										Number(seconds) > (variant.durationSec ?? 0)
									}
									onClick={() => void frame()}
								>
									{busy ? "Preparing…" : "Use this frame"}
								</Button>
								{platform !== "tiktok" && (
									<>
										<Text fontSize="sm" fontWeight="medium">
											Image library
										</Text>
										{canUpload && (
											<Field.Root>
												<Field.Label>Upload image</Field.Label>
												<Input
													type="file"
													accept={
														platform === "youtube_shorts"
															? "image/jpeg,image/png"
															: "image/jpeg,image/png,image/webp"
													}
													disabled={busy}
													onChange={(e) => void upload(e.target.files?.[0])}
												/>
											</Field.Root>
										)}
										<Grid templateColumns="repeat(3,1fr)" gap="2">
											{assets.filter(compatible).map((asset) => (
												<Button
													key={asset.id}
													variant="outline"
													h="auto"
													p="2"
													disabled={busy}
													onClick={() => choose(asset)}
												>
													<Stack minW="0">
														{asset.accessUrl && (
															<Image
																src={asset.accessUrl}
																alt={asset.title}
																height="80px"
																objectFit="cover"
															/>
														)}
														<Text truncate fontSize="xs">
															{asset.title}
														</Text>
													</Stack>
												</Button>
											))}
										</Grid>
									</>
								)}
								{error && (
									<Text role="alert" color="danger.fg" fontSize="sm">
										{error}
									</Text>
								)}
							</Stack>
						</Dialog.Body>
						<Dialog.Footer>
							<Button variant="ghost" onClick={onClose}>
								Close
							</Button>
						</Dialog.Footer>
					</Dialog.Content>
				</Dialog.Positioner>
			</Portal>
		</Dialog.Root>
	);
}
