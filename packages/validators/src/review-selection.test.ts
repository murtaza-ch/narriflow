import { describe, expect, test } from "bun:test";
import { decodeReviewSelection, encodeReviewSelection } from "./review-selection";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("review selection", () => {
  test("round-trips exports and their variants", () => {
    const items = [
      { exportId: uuid(1), variantIds: [uuid(10), uuid(11)] },
      { exportId: uuid(2), variantIds: [uuid(20)] },
    ];
    expect(decodeReviewSelection(encodeReviewSelection(items))).toEqual(items);
  });

  test("carries no authority: malformed entries are dropped, not repaired", () => {
    const encoded = [`${uuid(1)}:${uuid(10)}`, "not-a-uuid:also-not", `${uuid(3)}:`, `${uuid(4)}:bad,${uuid(40)}`].join(";");
    expect(decodeReviewSelection(encoded)).toEqual([
      { exportId: uuid(1), variantIds: [uuid(10)] },
      { exportId: uuid(4), variantIds: [uuid(40)] },
    ]);
  });

  test("bounds what a URL can make the composer process", () => {
    expect(decodeReviewSelection("x".repeat(4_001))).toEqual([]);
    expect(decodeReviewSelection(null)).toEqual([]);
    expect(decodeReviewSelection(undefined)).toEqual([]);
    const many = Array.from({ length: 30 }, (_, i) => `${uuid(i + 1)}:${uuid(100)}`).join(";");
    expect(decodeReviewSelection(many)).toHaveLength(20);
    const variants = Array.from({ length: 9 }, (_, i) => uuid(i + 1)).join(",");
    expect(decodeReviewSelection(`${uuid(1)}:${variants}`)[0]?.variantIds).toHaveLength(4);
  });
});
