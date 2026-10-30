import { describe, expect, test } from "bun:test";
import { userErrorMessage } from "@narriflow/validators";
import { FOLDER_NAME_TAKEN_MESSAGE, isFolderNameTaken } from "./folder-names";

const folders = [
  { id: "a", name: "Launch" },
  { id: "b", name: "Season  2" },
];

describe("isFolderNameTaken", () => {
  test("ignores case, surrounding and repeated spaces like the server", () => {
    expect(isFolderNameTaken("launch", folders)).toBe(true);
    expect(isFolderNameTaken("  LAUNCH ", folders)).toBe(true);
    expect(isFolderNameTaken("season 2", folders)).toBe(true);
    expect(isFolderNameTaken("Launch day", folders)).toBe(false);
  });

  test("an empty name is not a duplicate, and a folder never clashes with itself", () => {
    expect(isFolderNameTaken("   ", folders)).toBe(false);
    expect(isFolderNameTaken("LAUNCH", folders, "a")).toBe(false);
    expect(isFolderNameTaken("launch", folders, "b")).toBe(true);
  });

  test("the server's refusal reads the same as the inline hint", () => {
    expect(userErrorMessage("workspace_folder_name_taken")).toBe(FOLDER_NAME_TAKEN_MESSAGE);
  });
});
