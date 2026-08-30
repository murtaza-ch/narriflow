export type ProgramReleaseGroup =
  | "brand_profiles"
  | "visual_assets"
  | "brand_fonts"
  | "brand_kit_projection"
  | "campaign_operations"
  | "review_rooms"
  | "generated_media";

const RELEASE_ENV: Record<ProgramReleaseGroup, string> = {
  brand_profiles: "NARRIFLOW_WRITES_BRAND_PROFILES",
  visual_assets: "NARRIFLOW_WRITES_VISUAL_ASSETS",
  brand_fonts: "NARRIFLOW_WRITES_BRAND_FONTS",
  brand_kit_projection: "NARRIFLOW_WRITES_BRAND_KIT_PROJECTION",
  campaign_operations: "NARRIFLOW_WRITES_CAMPAIGN_OPERATIONS",
  review_rooms: "NARRIFLOW_WRITES_REVIEW_ROOMS",
  generated_media: "NARRIFLOW_WRITES_GENERATED_MEDIA",
};

export class ProgramWriteDisabledError extends Error {
  readonly code = "program_write_disabled";

  constructor(readonly group: ProgramReleaseGroup) {
    super("This feature is temporarily read-only");
    this.name = "ProgramWriteDisabledError";
  }
}

export function isProgramWriteEnabled(
  group: ProgramReleaseGroup,
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env[RELEASE_ENV[group]] === "1";
}

export function assertProgramWriteEnabled(
  group: ProgramReleaseGroup,
  env?: Record<string, string | undefined>,
): void {
  if (!isProgramWriteEnabled(group, env)) {
    throw new ProgramWriteDisabledError(group);
  }
}
