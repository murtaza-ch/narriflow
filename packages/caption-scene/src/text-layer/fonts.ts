import { CAPTION_FONT_FACES, type CaptionFontFace, type CaptionFontName, type StudioTextLayer, TEXT_LAYER_SHEAR_DEG, captionFontFace, resolveTextLayerFace } from "@narriflow/validators";
import { type UploadedFace, uploadedFaceKey } from "../scene";

/**
 * Which face each Text Layer draws in (title-text ticket 08). A layer draws its uploaded brand font
 * (`style.fontAsset`) when the renderer has resolved it, else its `font` family. Both renderers call
 * this with their own resolver (the worker: the uploads it downloaded and verified; the Studio: the
 * brand fonts whose files have loaded), so the layout and the measurement agree on the face.
 *
 * An uploaded font is a family of one face: bold is a fill-coloured outline and italic a shear,
 * unless the file itself is italic. Its fallback, for glyphs it lacks, is the face the layer's
 * `font` family would draw.
 *
 * Name collisions. libass selects a face by its internal name (`\fn`), and the export's fonts
 * directory can hold one file per name, so faces that share a name (case-insensitive) are settled
 * the same way in both renderers:
 *  - an upload that shares a vendored caption face's name is drawn as that vendored face (a
 *    vendored face is shared by every layer and by captions, so an upload never displaces it);
 *  - two uploads that share a name: the first in layer order wins, and a later layer draws the
 *    winner's file.
 * The worker logs each collision.
 */

/** A resolved upload: its face metrics, as parsed from the file (`parseBrandFont`). */
export type TextLayerUploadResolver = (upload: UploadedFace) => CaptionFontFace | null;

/** What one layer is drawn in. */
export interface TextLayerFace {
  /** The catalog face, or the upload's fallback when `upload` is set. */
  readonly face: CaptionFontName;
  /** The upload drawn in place of `face`. */
  readonly upload?: UploadedFace;
  /** Cap height of the drawn face, em. */
  readonly capHeight: number;
  readonly fauxBold: boolean;
  readonly shearDeg: number;
}

export interface TextLayerFontCollision {
  readonly layerId: string;
  /** The upload the layer asked for. */
  readonly requested: UploadedFace;
  /** The shared internal name. */
  readonly name: string;
  /** What the layer is drawn in instead: an earlier layer's upload, or a vendored face. */
  readonly drawnAs: { readonly kind: "upload"; readonly upload: UploadedFace } | { readonly kind: "catalog"; readonly face: CaptionFontName };
}

const nameKey = (name: string) => name.normalize("NFKC").toLowerCase();
const VENDORED = new Map(CAPTION_FONT_FACES.map((face) => [nameKey(face.assName), face.name as CaptionFontName]));

/** The face of a layer drawn in its `font` family. */
export function catalogTextLayerFace(style: Pick<StudioTextLayer["style"], "font" | "bold" | "italic">): TextLayerFace {
  const { face, fauxBold, shearDeg } = resolveTextLayerFace(style);
  return { face, capHeight: captionFontFace(face).capHeight, fauxBold, shearDeg };
}

/** The face every layer draws in, in document order, and the uploads that lost a name collision. */
export function textLayerFaces(
  layers: readonly { readonly id: string; readonly style: StudioTextLayer["style"] }[],
  resolve: TextLayerUploadResolver | null,
): { faces: TextLayerFace[]; collisions: TextLayerFontCollision[] } {
  const winners = new Map<string, { upload: UploadedFace; face: CaptionFontFace }>();
  const collisions: TextLayerFontCollision[] = [];
  const faces = layers.map((layer) => {
    const { style } = layer;
    const family = catalogTextLayerFace(style);
    const reference = style.fontAsset;
    const resolved = reference && resolve ? resolve({ id: reference.id, fingerprint: reference.fingerprint }) : null;
    if (!reference || !resolved) return family;
    const requested: UploadedFace = { id: reference.id, fingerprint: reference.fingerprint };
    const name = nameKey(resolved.assName);
    // An upload is a one-face family: bold by outline, italic by shear unless the drawn file leans.
    const oneFace = (drawn: CaptionFontFace, upload?: UploadedFace): TextLayerFace => ({
      face: family.face,
      ...(upload ? { upload } : {}),
      capHeight: drawn.capHeight,
      fauxBold: style.bold,
      shearDeg: style.italic && drawn.style !== "italic" ? TEXT_LAYER_SHEAR_DEG : 0,
    });
    const vendored = VENDORED.get(name);
    if (vendored) {
      collisions.push({ layerId: layer.id, requested, name: resolved.assName, drawnAs: { kind: "catalog", face: vendored } });
      return { ...oneFace(captionFontFace(vendored)), face: vendored };
    }
    const winner = winners.get(name);
    if (!winner) {
      winners.set(name, { upload: requested, face: resolved });
      return oneFace(resolved, requested);
    }
    if (uploadedFaceKey(winner.upload) !== uploadedFaceKey(requested)) {
      collisions.push({ layerId: layer.id, requested, name: resolved.assName, drawnAs: { kind: "upload", upload: winner.upload } });
    }
    return oneFace(winner.face, winner.upload);
  });
  return { faces, collisions };
}

/** The uploads the layers draw (collision winners only), in first-use order. */
export function textLayerUploads(faces: readonly TextLayerFace[]): UploadedFace[] {
  const seen = new Map<string, UploadedFace>();
  for (const face of faces) if (face.upload && !seen.has(uploadedFaceKey(face.upload))) seen.set(uploadedFaceKey(face.upload), face.upload);
  return [...seen.values()];
}
