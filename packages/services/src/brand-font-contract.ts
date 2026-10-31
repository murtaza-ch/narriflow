import type { CaptionFontFace, SceneBlock } from "@narriflow/validators";
import { ExpectedDomainFailureError, type ExpectedDomainFailureCatalog } from "./expected-domain-failure";

const brandFontIntegrityFailureCatalog = {
  brand_font_collection_unsupported: "unprocessable",
  brand_font_fingerprint_mismatch: "unprocessable",
  brand_font_format_mismatch: "unprocessable",
  brand_font_key_forbidden: "forbidden",
	brand_font_in_use: "conflict",
  brand_font_malformed: "unprocessable",
  brand_font_mime_mismatch: "unprocessable",
  brand_font_name_invalid: "invalid",
  brand_font_not_found: "missing",
  brand_font_object_missing: "missing",
  brand_font_replacement_invalid: "unprocessable",
  brand_font_size_mismatch: "unprocessable",
	brand_font_storage_unavailable: "unavailable",
  scene_brand_font_invalid: "unprocessable",
  scene_brand_font_profile_invalid: "unprocessable",
} as const satisfies ExpectedDomainFailureCatalog<string>;

type BrandFontIntegrityFailureCode = keyof typeof brandFontIntegrityFailureCatalog;

export class BrandFontIntegrityError extends ExpectedDomainFailureError<BrandFontIntegrityFailureCode> {
  constructor(code: BrandFontIntegrityFailureCode) {
    super({ code, kind: brandFontIntegrityFailureCatalog[code], message: "The selected Brand font could not be verified" });
    this.name = "BrandFontIntegrityError";
  }
}

export class BrandFontReferenceError extends ExpectedDomainFailureError<"brand_font_in_use"> {
  constructor() {
    super({
      code: "brand_font_in_use",
      kind: brandFontIntegrityFailureCatalog.brand_font_in_use,
      message:
        "Remove this font from every Brand Profile, caption style and Scene Template before deleting it",
    });
    this.name = "BrandFontReferenceError";
  }
}

export function assertSceneBrandFontReferences(
	scenes: readonly SceneBlock[],
	fonts: readonly { id: string; family: string; fingerprint: string }[],
): void {
	const byId = new Map(fonts.map((font) => [font.id, font]));
	for (const scene of scenes) {
		if (scene.content.kind !== "text" || !scene.content.fontAsset) continue;
		const font = byId.get(scene.content.fontAsset.id);
		if (
			!font ||
			font.fingerprint !== scene.content.fontAsset.fingerprint ||
			font.family !== scene.content.fontFamily
		) {
			throw new BrandFontIntegrityError("scene_brand_font_invalid");
		}
	}
}

export interface ParsedBrandFont {
  format: "ttf" | "otf" | "woff2";
  family: string;
  style: string;
  weight: number;
  face: CaptionFontFace;
}

