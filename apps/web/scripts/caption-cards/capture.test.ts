import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { captureCardFrame, type CaptureBrowser } from "./capture";

const windows: Window[] = [];
afterEach(async () => {
  await Promise.all(windows.splice(0).map((window) => window.happyDOM.close()));
});

function fixture(duringScreenshot?: (window: Window) => void) {
  const window = new Window();
  windows.push(window);
  window.eval('window.__card = { run: "take", set() {} }');
  let screenshots = 0;
  const browser: CaptureBrowser = {
    evaluate: async <T>(expression: string) => window.eval(expression) as T,
    send: async <T>() => {
      screenshots++;
      duringScreenshot?.(window);
      return { data: Buffer.from("frame").toString("base64") } as T;
    },
  };
  return { window, capture: () => captureCardFrame(browser, "ledge", "take", 4.5, { x: 0, y: 0, width: 200, height: 250 }), screenshots: () => screenshots };
}

function buildError(window: Window) {
  const portal = window.document.createElement("nextjs-portal");
  const shadow = portal.attachShadow({ mode: "open" });
  shadow.innerHTML = '<div data-nextjs-dialog role="dialog">Build Error: Export not found</div>';
  window.document.body.append(portal);
}

test("records a healthy frame", async () => {
  const f = fixture();
  expect((await f.capture()).toString()).toBe("frame");
});

test("allows the development indicator without an error dialog", async () => {
  const f = fixture();
  const portal = f.window.document.createElement("nextjs-portal");
  portal.attachShadow({ mode: "open" }).innerHTML = '<button data-issues-open>Open Next.js Dev Tools</button>';
  f.window.document.body.append(portal);
  expect((await f.capture()).toString()).toBe("frame");
});

test("rejects a build error over a still-mounted caption card", async () => {
  const f = fixture();
  buildError(f.window);
  await expect(f.capture()).rejects.toThrow("Next.js error overlay");
  expect(f.screenshots()).toBe(0);
});

test("rejects an error that appears during the screenshot", async () => {
  const f = fixture(buildError);
  await expect(f.capture()).rejects.toThrow("Next.js error overlay");
});

test("rejects a hidden error instead of trusting overlay-hiding CSS", async () => {
  const f = fixture();
  buildError(f.window);
  f.window.document.querySelector("nextjs-portal")!.setAttribute("style", "display: none !important");
  await expect(f.capture()).rejects.toThrow("Next.js error overlay");
});

test("rejects a control replaced during the screenshot", async () => {
  const f = fixture((window) => window.eval('window.__card.run = "new take"'));
  await expect(f.capture()).rejects.toThrow("reloaded while recording");
});
