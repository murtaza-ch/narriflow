import { WorkflowFailure } from "@narriflow/services";
import {
  productionRenderProcessAdapter,
  type ProductionRenderProcessAdapter,
  type RenderProcessDiagnostic,
} from "./render-process-adapter";

export const DEFAULT_RENDER_MEDIA_FPS = 30;
export const HTTP_SOURCE_RW_TIMEOUT_US = 30_000_000;

export interface RenderMediaProbe {
  width: number;
  height: number;
  hasVideo: boolean;
  hasAudio: boolean;
  fps: number;
}

export interface RenderMediaProbeRequest {
  sourcePath: string;
  signal: AbortSignal;
  deadlineMs: number;
  killGraceMs: number;
  diagnose?(event: RenderProcessDiagnostic): void;
}

function isHttpSource(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

function parseFrameRate(rFrameRate: string | undefined): number {
  if (!rFrameRate) return DEFAULT_RENDER_MEDIA_FPS;
  const [numPart, denPart] = rFrameRate.split("/");
  const num = Number(numPart);
  const den = denPart === undefined ? 1 : Number(denPart);
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) {
    return DEFAULT_RENDER_MEDIA_FPS;
  }
  const fps = num / den;
  return Number.isFinite(fps) && fps > 0 ? fps : DEFAULT_RENDER_MEDIA_FPS;
}

export class ProductionRenderMediaAdapter {
  constructor(
    private readonly processAdapter: Pick<
      ProductionRenderProcessAdapter,
      "execute"
    > = productionRenderProcessAdapter,
  ) {}

  async probe(request: RenderMediaProbeRequest): Promise<RenderMediaProbe> {
    if (!Number.isFinite(request.deadlineMs) || request.deadlineMs <= 0) {
      throw new Error("Render media probe deadline must be finite and positive");
    }
    request.signal.throwIfAborted();

    const output = await this.processAdapter.execute({
      command: "ffprobe",
      args: [
        "-v",
        "quiet",
        "-print_format",
        "json",
        "-show_streams",
        ...(isHttpSource(request.sourcePath)
          ? ["-rw_timeout", String(HTTP_SOURCE_RW_TIMEOUT_US)]
          : []),
        request.sourcePath,
      ],
      signal: request.signal,
      deadlineMs: request.deadlineMs,
      killGraceMs: request.killGraceMs,
      captureStdout: true,
      diagnose: request.diagnose,
    });

    let data: {
      streams?: Array<{
        codec_type?: string;
        width?: number;
        height?: number;
        r_frame_rate?: string;
      }>;
    };
    try {
      data = JSON.parse(output) as typeof data;
    } catch (error) {
      throw new WorkflowFailure(
        "source_media_invalid",
        "permanent",
        "Required source media could not be probed",
        error instanceof Error ? { cause: error } : undefined,
      );
    }

    const streams = data.streams ?? [];
    const videoStream = streams.find((stream) => stream.codec_type === "video");
    const audioStream = streams.find((stream) => stream.codec_type === "audio");
    if (!videoStream && !audioStream) {
      throw new WorkflowFailure(
        "source_media_invalid",
        "permanent",
        "Required source media has no readable audio or video stream",
      );
    }

    return {
      width: videoStream?.width ?? 0,
      height: videoStream?.height ?? 0,
      hasVideo: Boolean(videoStream),
      hasAudio: Boolean(audioStream),
      fps: parseFrameRate(videoStream?.r_frame_rate),
    };
  }
}

export const productionRenderMediaAdapter = new ProductionRenderMediaAdapter();
