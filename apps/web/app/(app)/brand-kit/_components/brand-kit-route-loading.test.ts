import { describe, expect, test } from "bun:test";
import { brandKitRouteFor } from "./brand-kit-route-loading";

describe("brandKitRouteFor", () => {
  test("names the page under /brand-kit that a pathname opens", () => {
    expect(brandKitRouteFor("/brand-kit")).toBe("list");
    expect(brandKitRouteFor("/brand-kit/new")).toBe("new-profile");
    expect(brandKitRouteFor("/brand-kit/b1")).toBe("profile");
    expect(brandKitRouteFor("/brand-kit/styles/new")).toBe("new-style");
    expect(brandKitRouteFor("/brand-kit/styles/s1")).toBe("style");
  });
});
