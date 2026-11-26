"use client";

/**
 * A clip's title drawn over its card while the card plays the preview proxy (title-text spec
 * section 8). The same pieces as the Studio and the export: `useTextLayerScene` builds the layer as a
 * static Caption Scene in the selected format's canvas pixels (once per layer and format, after its
 * faces load), and `CaptionSceneLayers` paints it at the card's scale from the player's time mapped
 * to the clip's edited timeline. A card resize only changes the scale; nothing is rebuilt per frame.
 */

import { useMemo } from "react";
import { Box } from "@chakra-ui/react";
import type { CaptionTimeSource } from "./clips/[clipId]/studio/_components/caption-block-painter";
import { CaptionSceneLayers } from "./clips/[clipId]/studio/_components/caption-scene-painter";
import { useTextLayerScene } from "./clips/[clipId]/studio/_components/text-layer-scene";
import { useElementWidth } from "./clips/[clipId]/studio/_components/text-layer-sample";
import type { ClipTitleOverlayModel } from "./clip-title-overlay-model";

export function ClipTitleOverlay({
	model,
	canvas,
	clock,
}: {
	model: ClipTitleOverlayModel;
	/** The selected format's target canvas (px); the overlay box has its aspect ratio. */
	canvas: { readonly width: number; readonly height: number };
	/** The player's time, media seconds. */
	clock: CaptionTimeSource;
}) {
	const [ref, width] = useElementWidth<HTMLDivElement>();
	const entries = useMemo(() => [{ layer: model.layer, window: model.window }], [model.layer, model.window]);
	const built = useTextLayerScene(entries, canvas);
	const timeSource = useMemo<CaptionTimeSource>(
		() => ({ getSnapshot: () => model.editedSecAt(clock.getSnapshot()), subscribe: clock.subscribe }),
		[model, clock],
	);
	return (
		<Box ref={ref} position="absolute" inset="0" overflow="hidden" pointerEvents="none" aria-hidden data-clip-title-overlay>
			{built && width > 0 ? <CaptionSceneLayers built={built.built} canvas={canvas} scale={width / canvas.width} timeSource={timeSource} /> : null}
		</Box>
	);
}
