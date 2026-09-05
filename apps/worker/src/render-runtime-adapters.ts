import { stat, writeFile } from "node:fs/promises";

export interface RenderWorkspaceAdapter {
  stat: typeof stat;
  writeFile: typeof writeFile;
}

export interface RenderClockAdapter {
  nowMs(): number;
  setTimeout(
    callback: () => void,
    delayMs: number,
  ): ReturnType<typeof setTimeout>;
  clearTimeout(handle: ReturnType<typeof setTimeout>): void;
}

export const productionRenderWorkspaceAdapter: RenderWorkspaceAdapter = {
  stat,
  writeFile,
};

export const productionRenderClockAdapter: RenderClockAdapter = {
  nowMs: () => Date.now(),
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle),
};
