/**
 * The export's frame grid: the integer-ms times at which the worker samples a scene and libass paints it.
 * Programs that reason about what the viewer sees ("painted on at least two frames", "visible on the
 * first frame at or after onset") use these helpers so they agree with the ASS writer exactly.
 */

/** The frame rate a scene is planned for when the render's real rate is unknown (the Studio preview). */
export const SCENE_DEFAULT_FPS = 30;

/** The highest sampling rate; a faster render is sampled at this rate and libass interpolates between. */
export const SCENE_MAX_SAMPLE_FPS = 60;

/** The sampling rate the worker uses for `fps`: clamped to 1..`SCENE_MAX_SAMPLE_FPS`. */
export function sceneSampleRate(fps: number = SCENE_DEFAULT_FPS): number {
  return Math.min(SCENE_MAX_SAMPLE_FPS, Math.max(1, fps));
}

/** The time, integer ms, of export frame `frame`. */
export function exportFrameTime(frame: number, fps: number = SCENE_DEFAULT_FPS): number {
  return Math.round((frame * 1000) / sceneSampleRate(fps));
}

/** Render times, integer ms, of the export frames inside `[fromMs, toMs)` (libass is given rounded ms). */
export function exportFrameTimes(fromMs: number, toMs: number, fps: number = SCENE_DEFAULT_FPS): number[] {
  const rate = sceneSampleRate(fps);
  const times: number[] = [];
  for (let frame = Math.max(0, Math.ceil(((fromMs - 0.5) * rate) / 1000)); ; frame++) {
    const t = exportFrameTime(frame, rate);
    if (t >= toMs) break;
    if (t >= fromMs) times.push(t);
  }
  return times;
}

/** The first export frame time strictly after `t`. */
export function exportFrameAfter(t: number, fps: number = SCENE_DEFAULT_FPS): number {
  const rate = sceneSampleRate(fps);
  let frame = Math.max(0, Math.floor((t * rate) / 1000));
  while (exportFrameTime(frame, rate) <= t) frame++;
  return exportFrameTime(frame, rate);
}

/** The first export frame time at or after `t`. */
export function exportFrameAtOrAfter(t: number, fps: number = SCENE_DEFAULT_FPS): number {
  const rate = sceneSampleRate(fps);
  let frame = Math.max(0, Math.floor((t * rate) / 1000) - 1);
  while (exportFrameTime(frame, rate) < t) frame++;
  return exportFrameTime(frame, rate);
}

/** The last export frame time at or before `t` (0 when `t` is before the first frame). */
export function exportFrameAtOrBefore(t: number, fps: number = SCENE_DEFAULT_FPS): number {
  const rate = sceneSampleRate(fps);
  let frame = Math.max(0, Math.ceil((t * rate) / 1000) + 1);
  while (frame > 0 && exportFrameTime(frame, rate) > t) frame--;
  return exportFrameTime(frame, rate);
}

/** How many export frames a piece living `[fromMs, toMs)` is sampled on. */
export function paintedFrameCount(fromMs: number, toMs: number, fps: number = SCENE_DEFAULT_FPS): number {
  return exportFrameTimes(fromMs, toMs, fps).length;
}
