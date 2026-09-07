import type { LogoPosition } from "./logo-position";
import type { StudioLogo } from "./studio-edits";

/** The logo's placement/opacity/scale as captured in the project brand
 *  snapshot — the ASSET's default presentation. */
export interface LogoSnapshotSettings {
  position: LogoPosition;
  opacity: number;
  scalePct: number;
}

/** Fully-resolved settings for rendering/previewing a clip's logo, after
 *  merging any per-clip override over the snapshot default. */
export interface EffectiveLogoSettings {
  enabled: boolean;
  position: LogoPosition;
  opacity: number;
  scalePct: number;
}

/**
 * Merge a clip's `studioEdits.logo` override over the project brand
 * snapshot's logo settings (vizard-parity.md Phase A step 6). The snapshot
 * stays the source of truth for the logo ASSET; this only resolves how it's
 * *shown* on this particular clip:
 *  - `null` on `position`/`opacity`/`scalePct` inherits the snapshot value.
 *  - `enabled: false` turns the logo off for this clip regardless of the
 *    snapshot (there is no snapshot-level "enabled" — presence of a logo
 *    asset is implied by a non-null `logoStorageKey`).
 *  - No override at all (`overrides` null/undefined, e.g. legacy studioEdits
 *    that predate this field) behaves exactly like the all-null default:
 *    enabled, fully inheriting the snapshot.
 *
 * Pure and shared verbatim by the worker (burn-in, render-clips.ts) and the
 * studio preview overlay (video-preview.tsx) so the two can never fork.
 */
export function resolveEffectiveLogoSettings(
  snapshot: LogoSnapshotSettings,
  overrides: StudioLogo | null | undefined,
): EffectiveLogoSettings {
  return {
    enabled: overrides?.enabled ?? true,
    position: overrides?.position ?? snapshot.position,
    opacity: overrides?.opacity ?? snapshot.opacity,
    scalePct: overrides?.scalePct ?? snapshot.scalePct,
  };
}
