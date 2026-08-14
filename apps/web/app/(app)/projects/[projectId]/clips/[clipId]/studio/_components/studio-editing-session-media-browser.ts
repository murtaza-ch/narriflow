import type {
  StudioMediaAdapter,
  StudioMediaBinding,
  StudioMediaCommand,
  StudioMediaEvent,
} from "./studio-editing-session";

type VideoFrameCallback = (
  now: DOMHighResTimeStamp,
  metadata: { mediaTime: number },
) => void;

type VideoWithFrameCallback = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
};

export interface StudioBrowserMediaAdapter extends StudioMediaAdapter {
  attach(element: HTMLVideoElement | null): void;
}

function bindingsEqual(
  left: StudioMediaBinding,
  right: StudioMediaBinding | null,
): boolean {
  return (
    right !== null &&
    left.sessionGeneration === right.sessionGeneration &&
    left.mediaGeneration === right.mediaGeneration
  );
}

class BrowserStudioMediaAdapter implements StudioBrowserMediaAdapter {
  private element: VideoWithFrameCallback | null = null;
  private listener: ((event: StudioMediaEvent) => void) | null = null;
  private binding: StudioMediaBinding | null = null;
  private latestLoad: Extract<StudioMediaCommand, { type: "load" }> | null = null;
  private frameCallbackId = 0;
  private removeEventListeners: (() => void) | null = null;

  subscribe(listener: (event: StudioMediaEvent) => void): () => void {
    this.listener = listener;
    return () => {
      if (this.listener === listener) this.listener = null;
    };
  }

  attach(element: HTMLVideoElement | null): void {
    if (this.element === element) return;
    this.unbindElement();
    this.element = element as VideoWithFrameCallback | null;
    if (this.element && this.latestLoad) this.applyLoad(this.latestLoad);
  }

  command(command: StudioMediaCommand): void {
    if (command.type === "load") {
      this.latestLoad = command;
      if (this.element) this.applyLoad(command);
      return;
    }
    const element = this.element;
    if (command.type === "unload") {
      this.latestLoad = null;
      this.unbindElement();
      if (element) {
        element.removeAttribute("src");
        element.load();
      }
      this.element = element;
      this.binding = command.binding;
      return;
    }
    const latestLoad = this.latestLoad;
    if (!latestLoad || !bindingsEqual(command.binding, latestLoad.binding)) return;
    switch (command.type) {
      case "seek":
        this.latestLoad = { ...latestLoad, mediaTimeSec: command.mediaTimeSec };
        break;
      case "play":
        this.latestLoad = { ...latestLoad, playing: true };
        break;
      case "pause":
        this.latestLoad = { ...latestLoad, playing: false };
        break;
      case "set-rate":
        this.latestLoad = { ...latestLoad, rate: command.rate };
        break;
      case "set-audio":
        this.latestLoad = {
          ...latestLoad,
          muted: command.muted,
          volume: command.volume,
        };
        break;
    }
    if (!bindingsEqual(command.binding, this.binding)) return;
    if (!element) return;
    switch (command.type) {
      case "seek":
        element.currentTime = command.mediaTimeSec;
        break;
      case "play":
        void element.play().catch(() => {
          if (bindingsEqual(command.binding, this.binding)) {
            this.listener?.({ type: "paused", binding: command.binding });
          }
        });
        break;
      case "pause":
        element.pause();
        break;
      case "set-rate":
        element.playbackRate = command.rate;
        break;
      case "set-audio":
        element.muted = command.muted;
        element.volume = command.volume;
        break;
    }
  }

  private applyLoad(
    command: Extract<StudioMediaCommand, { type: "load" }>,
  ): void {
    const element = this.element;
    if (!element) return;
    this.unbindEventsOnly();
    this.binding = command.binding;
    const binding = command.binding;
    let metadataPending = true;
    const emit = (event: StudioMediaEvent) => {
      if (bindingsEqual(binding, this.binding)) this.listener?.(event);
    };
    const onLoadedMetadata = () => {
      const desired = this.latestLoad;
      if (
        !desired ||
        !bindingsEqual(binding, desired.binding) ||
        !bindingsEqual(binding, this.binding)
      ) {
        return;
      }
      metadataPending = false;
      element.currentTime = desired.mediaTimeSec;
      element.playbackRate = desired.rate;
      element.muted = desired.muted;
      element.volume = desired.volume;
      if (desired.playing) {
        void element.play().catch(() => {
          emit({ type: "paused", binding });
        });
      } else if (!element.paused) {
        element.pause();
      }
    };
    const onPlay = () => emit({ type: "played", binding });
    const onPause = () => {
      const desired = this.latestLoad;
      if (
        metadataPending &&
        desired?.playing &&
        bindingsEqual(binding, desired.binding)
      ) {
        return;
      }
      emit({ type: "paused", binding });
    };
    const onEnded = () => emit({ type: "ended", binding });
    const onSeeked = () =>
      emit({ type: "seeked", binding, mediaTimeSec: element.currentTime });
    const onTimeUpdate = () => {
      if (!element.requestVideoFrameCallback) {
        emit({ type: "time", binding, mediaTimeSec: element.currentTime });
      }
    };
    element.addEventListener("loadedmetadata", onLoadedMetadata);
    element.addEventListener("play", onPlay);
    element.addEventListener("pause", onPause);
    element.addEventListener("ended", onEnded);
    element.addEventListener("seeked", onSeeked);
    element.addEventListener("timeupdate", onTimeUpdate);
    this.removeEventListeners = () => {
      element.removeEventListener("loadedmetadata", onLoadedMetadata);
      element.removeEventListener("play", onPlay);
      element.removeEventListener("pause", onPause);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("seeked", onSeeked);
      element.removeEventListener("timeupdate", onTimeUpdate);
    };
    this.startFrameLoop(element, binding);
    element.src = command.url;
    element.playbackRate = command.rate;
    element.muted = command.muted;
    element.volume = command.volume;
    element.load();
  }

  private startFrameLoop(
    element: VideoWithFrameCallback,
    binding: StudioMediaBinding,
  ): void {
    if (!element.requestVideoFrameCallback) return;
    const onFrame: VideoFrameCallback = (_now, metadata) => {
      if (!bindingsEqual(binding, this.binding) || this.element !== element) return;
      this.listener?.({ type: "time", binding, mediaTimeSec: metadata.mediaTime });
      this.frameCallbackId = element.requestVideoFrameCallback!(onFrame);
    };
    this.frameCallbackId = element.requestVideoFrameCallback(onFrame);
  }

  private unbindEventsOnly(): void {
    if (
      this.frameCallbackId !== 0 &&
      this.element?.cancelVideoFrameCallback
    ) {
      this.element.cancelVideoFrameCallback(this.frameCallbackId);
    }
    this.frameCallbackId = 0;
    this.removeEventListeners?.();
    this.removeEventListeners = null;
  }

  private unbindElement(): void {
    this.unbindEventsOnly();
    this.element = null;
  }
}

export function createBrowserStudioMediaAdapter(): StudioBrowserMediaAdapter {
  return new BrowserStudioMediaAdapter();
}
