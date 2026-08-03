import { describe, expect, test } from "bun:test";
import { completeSave, requestSave, type SaveQueueState } from "./save-queue";

describe("save-queue", () => {
  test("idle -> requestSave starts a save immediately", () => {
    const transition = requestSave("idle");
    expect(transition).toEqual({ state: "saving", shouldStartSave: true });
  });

  test("a request while saving marks dirty instead of starting a second save", () => {
    const transition = requestSave("saving");
    expect(transition).toEqual({ state: "saving-dirty", shouldStartSave: false });
  });

  test("further requests while already dirty stay dirty (still single-flight)", () => {
    const transition = requestSave("saving-dirty");
    expect(transition).toEqual({ state: "saving-dirty", shouldStartSave: false });
  });

  test("completing a plain save with no pending edits returns to idle", () => {
    const transition = completeSave("saving");
    expect(transition).toEqual({ state: "idle", shouldStartSave: false });
  });

  test("completing a save that went dirty mid-flight immediately restarts", () => {
    const transition = completeSave("saving-dirty");
    expect(transition).toEqual({ state: "saving", shouldStartSave: true });
  });

  test("full sequence: rapid edits during a save collapse into exactly one follow-up save", () => {
    let state: SaveQueueState = "idle";

    // Debounce fires once -> starts the first save.
    let t = requestSave(state);
    state = t.state;
    expect(t.shouldStartSave).toBe(true);

    // Three more edits land while that save is in flight.
    t = requestSave(state);
    state = t.state;
    t = requestSave(state);
    state = t.state;
    t = requestSave(state);
    state = t.state;
    expect(state).toBe("saving-dirty");

    // The in-flight save finishes — because it went dirty, exactly one more
    // save starts (not three).
    t = completeSave(state);
    state = t.state;
    expect(t.shouldStartSave).toBe(true);
    expect(state).toBe("saving");

    // That follow-up save finishes with nothing new pending -> idle.
    t = completeSave(state);
    state = t.state;
    expect(t.shouldStartSave).toBe(false);
    expect(state).toBe("idle");
  });
});
