import { expect, test } from "bun:test";
import { createBrowserStudioMediaAdapter } from "./studio-editing-session-media-browser";
import type {
  StudioMediaBinding,
  StudioMediaEvent,
} from "./studio-editing-session";

class FakeVideoElement extends EventTarget {
  src = "";
  currentTime = 0;
  playbackRate = 1;
  muted = false;
  volume = 1;
  paused = true;
  loadCount = 0;
  playCount = 0;
  pauseCount = 0;

  load(): void {
    this.loadCount += 1;
  }

  async play(): Promise<void> {
    this.playCount += 1;
    this.paused = false;
    this.dispatchEvent(new Event("play"));
  }

  pause(): void {
    this.pauseCount += 1;
    this.paused = true;
    this.dispatchEvent(new Event("pause"));
  }

  removeAttribute(name: string): void {
    if (name === "src") this.src = "";
  }
}

test("browser media adapter translates commands and HTML media events", async () => {
  const adapter = createBrowserStudioMediaAdapter();
  const video = new FakeVideoElement();
  const events: StudioMediaEvent[] = [];
  const binding: StudioMediaBinding = {
    sessionGeneration: 2,
    mediaGeneration: 4,
  };
  adapter.subscribe((event) => events.push(event));
  adapter.attach(video as unknown as HTMLVideoElement);

  adapter.command({
    type: "load",
    binding,
    url: "https://cdn.example.com/proxy.mp4",
    mediaTimeSec: 7,
    rate: 1.5,
    playing: false,
    muted: true,
    volume: 0.6,
  });
  expect(video.src).toBe("https://cdn.example.com/proxy.mp4");
  expect(video.loadCount).toBe(1);
  video.dispatchEvent(new Event("loadedmetadata"));
  expect(video.currentTime).toBe(7);
  expect(video.playbackRate).toBe(1.5);
  expect(video.muted).toBe(true);
  expect(video.volume).toBe(0.6);

  adapter.command({ type: "play", binding });
  await Promise.resolve();
  video.currentTime = 8;
  video.dispatchEvent(new Event("timeupdate"));
  adapter.command({ type: "seek", binding, mediaTimeSec: 11 });
  video.dispatchEvent(new Event("seeked"));
  adapter.command({ type: "set-rate", binding, rate: 2 });
  adapter.command({ type: "pause", binding });

  expect(events).toEqual([
    { type: "played", binding },
    { type: "time", binding, mediaTimeSec: 8 },
    { type: "seeked", binding, mediaTimeSec: 11 },
    { type: "paused", binding },
  ]);
  expect(video.playbackRate).toBe(2);
});

test("browser media adapter keeps commands issued while metadata loads", () => {
  const adapter = createBrowserStudioMediaAdapter();
  const video = new FakeVideoElement();
  const binding: StudioMediaBinding = {
    sessionGeneration: 3,
    mediaGeneration: 7,
  };
  adapter.attach(video as unknown as HTMLVideoElement);

  adapter.command({
    type: "load",
    binding,
    url: "https://cdn.example.com/source.mp4",
    mediaTimeSec: 4,
    rate: 1,
    playing: true,
    muted: false,
    volume: 1,
  });
  adapter.command({ type: "seek", binding, mediaTimeSec: 12 });
  adapter.command({ type: "set-rate", binding, rate: 1.75 });
  adapter.command({ type: "set-audio", binding, muted: true, volume: 0.4 });
  adapter.command({ type: "pause", binding });

  video.dispatchEvent(new Event("loadedmetadata"));

  expect(video.currentTime).toBe(12);
  expect(video.playbackRate).toBe(1.75);
  expect(video.muted).toBe(true);
  expect(video.volume).toBe(0.4);
  expect(video.paused).toBe(true);
  expect(video.playCount).toBe(0);
});

test("browser media adapter ignores a load-transition pause before a playing swap", async () => {
  const adapter = createBrowserStudioMediaAdapter();
  const video = new FakeVideoElement();
  const events: StudioMediaEvent[] = [];
  const firstBinding: StudioMediaBinding = {
    sessionGeneration: 5,
    mediaGeneration: 8,
  };
  const secondBinding: StudioMediaBinding = {
    sessionGeneration: 5,
    mediaGeneration: 9,
  };
  adapter.subscribe((event) => events.push(event));
  adapter.attach(video as unknown as HTMLVideoElement);

  adapter.command({
    type: "load",
    binding: firstBinding,
    url: "https://cdn.example.com/proxy-a.mp4",
    mediaTimeSec: 6,
    rate: 1.25,
    playing: true,
    muted: false,
    volume: 1,
  });
  video.dispatchEvent(new Event("pause"));
  expect(events).toEqual([]);

  adapter.command({
    type: "load",
    binding: secondBinding,
    url: "https://cdn.example.com/proxy-b.mp4",
    mediaTimeSec: 9,
    rate: 1.25,
    playing: true,
    muted: false,
    volume: 1,
  });
  video.dispatchEvent(new Event("loadedmetadata"));
  await Promise.resolve();

  expect(video.src).toBe("https://cdn.example.com/proxy-b.mp4");
  expect(video.currentTime).toBe(9);
  expect(video.playCount).toBe(1);
  expect(events).toEqual([{ type: "played", binding: secondBinding }]);
});
