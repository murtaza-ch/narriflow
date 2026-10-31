/** Fixed observations after publication; there is no recurring account scan. */
export const CAPTURE_OFFSETS_MINUTES = [60, 1440, 4320, 10080, 40320] as const;
export const COMPARISON_SLOT = CAPTURE_OFFSETS_MINUTES.indexOf(10080);
