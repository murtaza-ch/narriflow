type WebCompositionEnvironment = Record<string, string | undefined>;

function enabled(environment: WebCompositionEnvironment, name: string): boolean {
  const value = environment[name]?.trim() || "1";
  if (value !== "0" && value !== "1") {
    throw new Error(`${name} must be 0 or 1`);
  }
  return value === "1";
}

export function parseCompositionCapabilities(
  environment: WebCompositionEnvironment,
): Readonly<{
  automaticSpeakerLayoutEnabled: boolean;
  explicitSplitLayoutEnabled: boolean;
  screenLayoutEnabled: boolean;
}> {
  return Object.freeze({
    automaticSpeakerLayoutEnabled: enabled(
      environment,
      "NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT",
    ),
    explicitSplitLayoutEnabled: enabled(
      environment,
      "NEXT_PUBLIC_SPLIT_LAYOUT",
    ),
    screenLayoutEnabled: enabled(environment, "NEXT_PUBLIC_SCREEN_LAYOUT"),
  });
}

export const compositionCapabilities = parseCompositionCapabilities({
  NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT:
    process.env.NEXT_PUBLIC_AUTOMATIC_SPEAKER_LAYOUT,
  NEXT_PUBLIC_SPLIT_LAYOUT: process.env.NEXT_PUBLIC_SPLIT_LAYOUT,
  NEXT_PUBLIC_SCREEN_LAYOUT: process.env.NEXT_PUBLIC_SCREEN_LAYOUT,
});
