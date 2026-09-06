import { describe, expect, test } from "bun:test";
import { createStudioAccess } from "./studio-access";

interface FixtureFields {
  documentVersion: number;
  isPlaying: boolean;
  saveState: "idle" | "saving";
}

describe("StudioAccess", () => {
  test("publishes only when one of the selected fields changes", () => {
    const source = createStudioAccess<FixtureFields>({
      documentVersion: 1,
      isPlaying: false,
      saveState: "idle",
    });
    const selection = source.access.select(["documentVersion", "saveState"]);
    const initial = selection.getSnapshot();
    let notifications = 0;
    const unsubscribe = selection.subscribe(() => {
      notifications += 1;
    });

    source.publish({
      documentVersion: 1,
      isPlaying: true,
      saveState: "idle",
    });

    expect(selection.getSnapshot()).toBe(initial);
    expect(notifications).toBe(0);

    source.publish({
      documentVersion: 2,
      isPlaying: true,
      saveState: "saving",
    });

    expect(selection.getSnapshot()).toEqual({
      documentVersion: 2,
      saveState: "saving",
    });
    expect(notifications).toBe(1);
    unsubscribe();
  });

  test("preserves the initial server snapshot after client publications", () => {
    const source = createStudioAccess<FixtureFields>({
      documentVersion: 1,
      isPlaying: false,
      saveState: "idle",
    });
    const selection = source.access.select(["isPlaying"]);
    const initialServerSnapshot = selection.getServerSnapshot();

    source.publish({ documentVersion: 2, isPlaying: true, saveState: "saving" });

    expect(selection.getServerSnapshot()).toBe(initialServerSnapshot);
    expect(selection.getServerSnapshot()).toEqual({ isPlaying: false });
    expect(selection.getSnapshot()).toEqual({ isPlaying: true });
  });

  test("caches multi-field snapshots between relevant updates", () => {
    const source = createStudioAccess<FixtureFields>({
      documentVersion: 1,
      isPlaying: false,
      saveState: "idle",
    });
    const selection = source.access.select(["documentVersion", "isPlaying"]);
    const initial = selection.getSnapshot();

    expect(selection.getSnapshot()).toBe(initial);

    source.publish({ documentVersion: 1, isPlaying: true, saveState: "idle" });
    const updated = selection.getSnapshot();

    expect(updated).not.toBe(initial);
    expect(updated).toEqual({ documentVersion: 1, isPlaying: true });
    expect(selection.getSnapshot()).toBe(updated);
  });

  test("notifies duplicate field selections once per publication", () => {
    const source = createStudioAccess<FixtureFields>({
      documentVersion: 1,
      isPlaying: false,
      saveState: "idle",
    });
    const selection = source.access.select([
      "documentVersion",
      "documentVersion",
    ]);
    let notifications = 0;
    const unsubscribe = selection.subscribe(() => {
      notifications += 1;
    });

    source.publish({ documentVersion: 2, isPlaying: false, saveState: "idle" });

    expect(notifications).toBe(1);
    expect(selection.getSnapshot()).toEqual({ documentVersion: 2 });
    unsubscribe();
  });

  test("unsubscribes idempotently and catches up before reuse", () => {
    const source = createStudioAccess<FixtureFields>({
      documentVersion: 1,
      isPlaying: false,
      saveState: "idle",
    });
    const selection = source.access.select(["saveState"]);
    let notifications = 0;
    const unsubscribe = selection.subscribe(() => {
      notifications += 1;
    });

    unsubscribe();
    unsubscribe();
    source.publish({ documentVersion: 2, isPlaying: true, saveState: "saving" });

    expect(notifications).toBe(0);
    expect(selection.getSnapshot()).toEqual({ saveState: "saving" });

    const secondUnsubscribe = selection.subscribe(() => {
      notifications += 1;
    });
    source.publish({ documentVersion: 3, isPlaying: false, saveState: "idle" });
    expect(notifications).toBe(1);
    secondUnsubscribe();
  });

  test("rejects an empty field selection at runtime", () => {
    const source = createStudioAccess<FixtureFields>({
      documentVersion: 1,
      isPlaying: false,
      saveState: "idle",
    });

    expect(() =>
      source.access.select(
        [] as unknown as readonly [keyof FixtureFields, ...(keyof FixtureFields)[]],
      ),
    ).toThrow("StudioAccess.select requires at least one field");
  });

  test("reuses the selection store for the same ordered fields", () => {
    const source = createStudioAccess<FixtureFields>({
      documentVersion: 1,
      isPlaying: false,
      saveState: "idle",
    });

    const first = source.access.select(["documentVersion", "saveState"]);
    const second = source.access.select(["documentVersion", "saveState"]);

    expect(second).toBe(first);
    expect(second.getSnapshot).toBe(first.getSnapshot);
    expect(second.getServerSnapshot).toBe(first.getServerSnapshot);
    expect(second.subscribe).toBe(first.subscribe);
  });

  test("tracks duplicate subscriptions independently", () => {
    const source = createStudioAccess<FixtureFields>({
      documentVersion: 1,
      isPlaying: false,
      saveState: "idle",
    });
    const selection = source.access.select(["isPlaying"]);
    let notifications = 0;
    const listener = () => {
      notifications += 1;
    };
    const unsubscribeFirst = selection.subscribe(listener);
    const unsubscribeSecond = selection.subscribe(listener);

    source.publish({ documentVersion: 1, isPlaying: true, saveState: "idle" });
    expect(notifications).toBe(2);

    unsubscribeFirst();
    unsubscribeFirst();
    source.publish({ documentVersion: 1, isPlaying: false, saveState: "idle" });
    expect(notifications).toBe(3);

    unsubscribeSecond();
    source.publish({ documentVersion: 1, isPlaying: true, saveState: "idle" });
    expect(notifications).toBe(3);
  });
});
