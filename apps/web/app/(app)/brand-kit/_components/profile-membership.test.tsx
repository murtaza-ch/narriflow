import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("next/navigation", () => ({ useRouter: () => ({ refresh: () => {} }) }));
const { MembershipRemoveButton, StyleAdder } = await import("./profile-membership");
const { ProfileAudioPicker } = await import("./profile-audio-picker");
const { BrandProfileDeleteButton, describeBrandProfileUsage } = await import("./brand-profile-delete-button");

const render = (node: React.ReactNode) => renderToStaticMarkup(<ChakraProvider value={system}>{node}</ChakraProvider>);

describe("profile membership controls", () => {
  test("the style picker lists the styles still free to add", () => {
    const html = render(<StyleAdder profileId="p1" nextPosition={0} styles={[{ id: "s1", name: "Editorial" }, { id: "s2", name: "Bold" }]} />);
    expect(html).toContain("Add style");
    expect(html).toContain("Editorial");
    expect(html).toContain("Bold");
  });

  test("a member can be removed by name", () => {
    expect(render(<MembershipRemoveButton profileId="p1" kind="audio" resourceId="a1" label="Whoosh" />)).toContain('aria-label="Remove Whoosh"');
  });

  test("audio starts as an add action and opens the library on demand", () => {
    const html = render(<ProfileAudioPicker profileId="p1" attachedIds={[]} nextPosition={0} />);
    expect(html).toContain("Add audio");
    expect(html).not.toContain("Search audio");
  });
});

describe("deleting a profile", () => {
  test("usage reads as default plus Recipes by name", () => {
    expect(describeBrandProfileUsage({ isDefault: true, recipes: [{ id: "1", name: "Weekly" }, { id: "2", name: "Daily" }] }))
      .toBe("Default for new projects · Used by 2 Recipes: Weekly, Daily");
    expect(describeBrandProfileUsage({ isDefault: false, recipes: [{ id: "1", name: "Weekly" }] })).toBe("Used by 1 Recipe: Weekly");
    expect(describeBrandProfileUsage({ isDefault: false, recipes: [] })).toBeNull();
  });

  test("every profile offers delete, including the default", () => {
    const html = render(<BrandProfileDeleteButton profileId="p1" name="Main" revision={1} usage={{ isDefault: true, recipes: [] }} replacements={[]} />);
    expect(html).toContain('aria-label="Delete Main"');
  });
});
