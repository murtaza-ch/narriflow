import { afterEach, describe, expect, test } from "bun:test";
import { browserStorage } from "./browser-storage";

const original = Object.getOwnPropertyDescriptor(globalThis, "window");

afterEach(() => {
  if (original) Object.defineProperty(globalThis, "window", original);
  else Reflect.deleteProperty(globalThis, "window");
});

function withWindow(window: unknown) {
  Object.defineProperty(globalThis, "window", { value: window, configurable: true, writable: true });
}

describe("browserStorage", () => {
  test("is null on the server", () => {
    Reflect.deleteProperty(globalThis, "window");
    expect(browserStorage()).toBeNull();
  });

  test("returns the browser's localStorage when it is available", () => {
    const storage = {} as Storage;
    withWindow({ localStorage: storage });
    expect(browserStorage()).toBe(storage);
  });

  test("reading the blocked property (SecurityError) is tolerated rather than thrown", () => {
    withWindow({
      get localStorage(): Storage {
        throw new DOMException("The operation is insecure.", "SecurityError");
      },
    });
    expect(browserStorage()).toBeNull();
  });
});
