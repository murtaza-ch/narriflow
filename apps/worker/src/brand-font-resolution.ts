import { createHash } from "node:crypto";
import { readFile, mkdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { CAPTION_FALLBACK_FONTS, CAPTION_FONTS_DIRECTORY } from "@narriflow/caption-fonts";
import {
  brandFontRenderer,
  rethrowWorkflowAttemptLost,
} from "@narriflow/services";
import {
  CAPTION_FONT_FACES,
  type CaptionPreset,
  type StudioTextLayer,
} from "@narriflow/validators";

export type FontReference = NonNullable<CaptionPreset["fontAsset"]>;
export type RenderBrandFont = ReturnType<typeof brandFontRenderer> & {
  path: string;
};
export type RenderBrandFonts = ReadonlyMap<string, RenderBrandFont>;
export const brandFontKey = (font: { id: string; fingerprint: string }) =>
  `${font.id}:${font.fingerprint}`;

export function documentFontReferences(document: {
  captionPreset: CaptionPreset;
  studioEdits: { textLayers: readonly StudioTextLayer[] };
}): FontReference[] {
  return [
    ...new Map(
      [
        document.captionPreset.fontAsset,
        ...document.studioEdits.textLayers.map((layer) => layer.fontAsset),
      ]
        .filter((font): font is FontReference => Boolean(font))
        .map((font) => [brandFontKey(font), font]),
    ).values(),
  ];
}

/** Missing or changed uploads use the saved built-in fallback, including after deletion. */
export async function resolveRenderBrandFonts(input: {
  references: readonly FontReference[];
  fonts: readonly {
    id: string;
    fingerprint: string;
    storageKey: string;
    format: string;
  }[];
  directory: string;
  signal?: AbortSignal;
  download: (key: string, path: string) => Promise<void>;
}) {
  const fonts = new Map<string, RenderBrandFont>();
  for (const reference of input.references) {
    input.signal?.throwIfAborted();
    const font = input.fonts.find(
      (candidate) =>
        candidate.id === reference.id &&
        candidate.fingerprint === reference.fingerprint,
    );
    if (!font) continue;
    const path = join(
      input.directory,
      `brand-font-${font.id}.${font.format.toLowerCase()}`,
    );
    try {
      await input.download(font.storageKey, path);
      const bytes = await readFile(path);
      if (
        createHash("sha256").update(bytes).digest("hex") !==
        reference.fingerprint
      )
        continue;
      fonts.set(brandFontKey(reference), { ...brandFontRenderer(bytes), path });
    } catch (error) {
      rethrowWorkflowAttemptLost(error);
      input.signal?.throwIfAborted();
      console.warn(
        JSON.stringify({
          level: "warn",
          message: "Custom font unavailable; using built-in font",
          fontId: reference.id,
        }),
      );
    }
  }
  return fonts;
}

/** libass accepts one font directory. Keep uploaded and vendored faces together per render. */
export async function prepareCaptionFontsDirectory(
  directory: string,
  fonts: RenderBrandFonts,
  reference: FontReference | null | undefined,
) {
  const font = reference ? fonts.get(brandFontKey(reference)) : null;
  if (!font) return CAPTION_FONTS_DIRECTORY;
  const target = join(
    directory,
    `caption-fonts-${reference!.id}-${reference!.fingerprint}`,
  );
  await mkdir(target, { recursive: true });
  const link = async (source: string, destination: string) => {
    try {
      await symlink(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  };
  // Only the caption's chosen upload belongs in libass's font set. Text
  // layers use fontfile directly. Exclude a vendored face with the same name
  // so uploading another version of a built-in font cannot select the wrong bytes.
  for (const face of CAPTION_FONT_FACES) {
    if (face.assName === font.face.assName) continue;
    await link(
      join(CAPTION_FONTS_DIRECTORY, face.file),
      join(target, face.file),
    );
  }
  // The pinned glyph fallback faces travel with every directory libass is given.
  for (const fallback of CAPTION_FALLBACK_FONTS) {
    await link(join(CAPTION_FONTS_DIRECTORY, fallback.file), join(target, fallback.file));
  }
  await link(font.path, join(target, `uploaded.${font.path.split(".").pop()}`));
  return target;
}
