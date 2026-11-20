import type { Measure } from "./scene";

/**
 * `measure` remembered for one build. A program asks for the same word many times (fits bisect a
 * size, rows are re-measured per cue and per candidate): Lyrics on a 3-minute clip makes 193 000
 * calls for 451 distinct texts, and a renderer's call is a Canvas `measureText` (Studio) or a
 * HarfBuzz shaping run (worker). The answer for one (text, face, size, spacing) never changes
 * within a build, so each is computed once. The memo lives as long as the returned function.
 */
export function memoMeasure(measure: Measure): Measure {
  const memo = new Map<string, ReturnType<Measure>>();
  return (text, face, sizePx, letterSpacingEm) => {
    const key = `${face}\0${sizePx}\0${letterSpacingEm}\0${text}`;
    let result = memo.get(key);
    if (!result) {
      result = measure(text, face, sizePx, letterSpacingEm);
      memo.set(key, result);
    }
    return result;
  };
}
