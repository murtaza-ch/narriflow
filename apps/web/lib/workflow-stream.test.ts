import { describe, expect, test } from "bun:test";
import {
  advanceWorkflowCursor,
  isAfterWorkflowCursor,
  normalizeWorkflowSeq,
} from "./workflow-stream";

describe("workflow stream cursor", () => {
  test("advances only for a newer safe sequence", () => {
    expect(isAfterWorkflowCursor(4, 5)).toBe(true);
    expect(advanceWorkflowCursor(4, 5)).toBe(5);
    expect(advanceWorkflowCursor(5, 9)).toBe(9);
    expect(isAfterWorkflowCursor(5, 5)).toBe(false);
    expect(advanceWorkflowCursor(5, 4)).toBe(5);
  });

  test("rejects malformed, negative, and unsafe sequences", () => {
    expect(normalizeWorkflowSeq("6")).toBeNull();
    expect(normalizeWorkflowSeq(-1)).toBeNull();
    expect(normalizeWorkflowSeq(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(advanceWorkflowCursor(5, { seq: 6 })).toBe(5);
  });
});
