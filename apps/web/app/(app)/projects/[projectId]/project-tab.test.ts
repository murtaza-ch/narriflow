import { expect, test } from "bun:test";
import { projectTabFromSearchParam } from "./project-tab";

test("projectTabFromSearchParam keeps supported tabs and defaults invalid input", () => {
  expect(projectTabFromSearchParam("transcript")).toBe("transcript");
  expect(projectTabFromSearchParam("review")).toBe("review");
  expect(projectTabFromSearchParam("activity")).toBe("activity");
  expect(projectTabFromSearchParam("unknown")).toBe("clips");
  expect(projectTabFromSearchParam(undefined)).toBe("clips");
});
