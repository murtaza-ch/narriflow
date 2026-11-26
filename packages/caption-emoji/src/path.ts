/** One path command on the 64 grid; structurally the same as caption-scene's `PathCmd`. */
export type CaptionEmojiPathCmd =
  | readonly ["M", number, number]
  | readonly ["L", number, number]
  | readonly ["C", number, number, number, number, number, number]
  | readonly ["Z"];

const ARITY = { M: 2, L: 2, C: 6, Z: 0 } as const;

/**
 * Parses compiled path data (absolute `M`, `L`, `C`, `Z`; a repeated letter may be left out)
 * into commands. Throws on anything else.
 */
export function parseCaptionEmojiPath(d: string): CaptionEmojiPathCmd[] {
  const tokens = d.match(/[MLCZ]|-?(?:\d+\.?\d*|\.\d+)/g) ?? [];
  if (tokens.join("").length !== d.replace(/\s/g, "").length) throw new Error("unsupported path data");
  const out: CaptionEmojiPathCmd[] = [];
  let letter: keyof typeof ARITY | null = null;
  for (let i = 0; i < tokens.length; ) {
    const token = tokens[i]!;
    if (token in ARITY) {
      letter = token as keyof typeof ARITY;
      i += 1;
      if (letter === "Z") {
        out.push(["Z"]);
        continue;
      }
    } else if (letter === null || letter === "Z") {
      throw new Error("path data starts with a number");
    }
    const arity = ARITY[letter];
    const values = tokens.slice(i, i + arity).map(Number);
    if (values.length !== arity || values.some((value) => !Number.isFinite(value))) throw new Error("truncated path data");
    out.push([letter, ...values] as unknown as CaptionEmojiPathCmd);
    i += arity;
  }
  return out;
}
