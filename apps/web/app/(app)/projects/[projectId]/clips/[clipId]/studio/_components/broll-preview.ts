import {
	planBrollWindow,
	type EditedTimeMap,
} from "@narriflow/validators";

/**
 * The renderer's manual B-roll path probes the downloaded asset before it
 * plans the cutaway. The studio can do the same once browser metadata loads;
 * until then, use the renderer's normal 3.5s cutaway length so the timeline
 * never hides an applied edit while metadata is still in flight.
 */
export const DEFAULT_BROLL_PREVIEW_DURATION_SEC = 3.5;

export interface ManualBrollPreviewWindow {
  startSec: number;
  endSec: number;
}

export function manualBrollPreviewWindow(
  clipDurationSec: number,
  assetDurationSec: number | null | undefined,
): ManualBrollPreviewWindow | null {
  const duration =
    assetDurationSec !== null &&
    assetDurationSec !== undefined &&
    Number.isFinite(assetDurationSec) &&
    assetDurationSec > 0
      ? assetDurationSec
      : DEFAULT_BROLL_PREVIEW_DURATION_SEC;

  return planBrollWindow(clipDurationSec, duration);
}

export function manualBrollPreviewWindowForEditedTimeMap(
	editedTimeMap: Pick<EditedTimeMap, "editedDurationSec">,
	assetDurationSec: number | null | undefined,
): ManualBrollPreviewWindow | null {
	return manualBrollPreviewWindow(
		editedTimeMap.editedDurationSec,
		assetDurationSec,
	);
}

export function isBrollPreviewActive(
  currentTimeSec: number,
  window: ManualBrollPreviewWindow | null,
): boolean {
  return Boolean(
    window &&
      currentTimeSec >= window.startSec &&
      currentTimeSec < window.endSec,
  );
}

export function brollPreviewLocalTime(
  currentTimeSec: number,
  window: ManualBrollPreviewWindow,
): number {
  return Math.max(0, currentTimeSec - window.startSec);
}
