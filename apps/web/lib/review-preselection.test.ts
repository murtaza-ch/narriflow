import { describe, expect, test } from "bun:test";
import { encodeReviewSelection } from "@narriflow/validators/review-selection";
import { resolveReviewPreselection } from "./review-preselection";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const candidates = [
  { id: uuid(1), editorRevision: 2, exports: [{ id: uuid(10), editorRevision: 2, variants: [{ id: uuid(100) }, { id: uuid(101) }] }, { id: uuid(11), editorRevision: 1, variants: [{ id: uuid(110) }] }] },
  { id: uuid(2), editorRevision: 5, exports: [{ id: uuid(20), editorRevision: 5, variants: [{ id: uuid(200) }] }] },
];

describe("composer preselection recheck", () => {
  test("selects current exports and their completed formats", () => {
    expect(resolveReviewPreselection(candidates, encodeReviewSelection([{ exportId: uuid(10), variantIds: [uuid(101)] }, { exportId: uuid(20), variantIds: [uuid(200)] }]))).toEqual({
      selections: { [uuid(1)]: { exportId: uuid(10), variantIds: [uuid(101)], required: true }, [uuid(2)]: { exportId: uuid(20), variantIds: [uuid(200)], required: true } },
      dropped: 0,
    });
  });
  test("drops stale revisions, unknown or foreign exports, missing formats, and second exports of a clip", () => {
    expect(resolveReviewPreselection(candidates, encodeReviewSelection([
      { exportId: uuid(11), variantIds: [uuid(110)] },
      { exportId: uuid(99), variantIds: [uuid(100)] },
      { exportId: uuid(20), variantIds: [uuid(999)] },
      { exportId: uuid(10), variantIds: [uuid(100)] },
    ]))).toEqual({ selections: { [uuid(1)]: { exportId: uuid(10), variantIds: [uuid(100)], required: true } }, dropped: 3 });
    expect(resolveReviewPreselection(candidates, undefined)).toBeNull();
  });
});
