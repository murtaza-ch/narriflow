import { create as parseFont } from "fontkit";
import { BrandFontIntegrityError, type ParsedBrandFont } from "@narriflow/services/brand-font-contract";

function normalizeFontName(value: string, maximumLength: number) {
  const normalized = value.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!normalized || normalized.length > maximumLength) {
    throw new BrandFontIntegrityError("brand_font_name_invalid");
  }
  return normalized;
}

export function parseBrandFont(bytes: Uint8Array): ParsedBrandFont {
  if (bytes.byteLength < 4) throw new BrandFontIntegrityError("brand_font_malformed");
  const signature = Buffer.from(bytes.subarray(0, 4));
  if (signature.toString("ascii") === "ttcf") throw new BrandFontIntegrityError("brand_font_collection_unsupported");
  const format = signature.toString("ascii") === "OTTO"
    ? "otf"
    : signature.toString("ascii") === "wOF2"
      ? "woff2"
      : signature.equals(Buffer.from([0x00, 0x01, 0x00, 0x00])) ||
          signature.toString("ascii") === "true"
        ? "ttf"
        : null;
  if (!format) throw new BrandFontIntegrityError("brand_font_malformed");
  try {
    const font = parseFont(Buffer.from(bytes));
    if ("fonts" in font) {
      throw new BrandFontIntegrityError("brand_font_collection_unsupported");
    }
    const family = normalizeFontName(font.familyName, 120);
    const style = normalizeFontName(font.subfamilyName, 80);
    if (!font.postscriptName || font.numGlyphs <= 0 || font.unitsPerEm <= 0) {
      throw new BrandFontIntegrityError("brand_font_malformed");
    }
    const weight = Math.max(
      100,
      Math.min(900, Math.round(font["OS/2"].usWeightClass || 400)),
    );
    const units = font.unitsPerEm;
    const metrics = font["OS/2"];
    const ascent = (metrics.winAscent || font.ascent) / units;
    const descent = (metrics.winDescent || Math.abs(font.descent)) / units;
    const capHeight = (font.capHeight || font.ascent) / units;
    const assName = normalizeFontName(font.fullName, 256);
    if (/[,\\{}\r\n]/.test(assName)) throw new BrandFontIntegrityError("brand_font_name_invalid");
    if (![ascent, descent, capHeight].every((value) => Number.isFinite(value) && value >= 0 && value <= 10) || ascent + descent === 0) throw new BrandFontIntegrityError("brand_font_malformed");
    return { format, family, style, weight, face: {
      name: family, file: "", assName,
      weight, style: font.italicAngle !== 0 ? "italic" : "normal",
      ascent, descent, capHeight,
    } };
  } catch (error) {
    if (error instanceof BrandFontIntegrityError) throw error;
    throw new BrandFontIntegrityError("brand_font_malformed");
  }
}

export function parseBrandFontHeader(bytes: Uint8Array): "ttf" | "otf" | "woff2" {
  return parseBrandFont(bytes).format;
}

/** Validate the exact uploaded bytes and read the face metrics the caption burn-in needs; the worker shapes the saved file with HarfBuzz. */
export function brandFontRenderer(bytes: Uint8Array) {
  const parsed = parseBrandFont(bytes);
  const font = parseFont(Buffer.from(bytes));
  if (!("layout" in font)) throw new BrandFontIntegrityError("brand_font_collection_unsupported");
  return {
    face: parsed.face,
  };
}

