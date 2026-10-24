import { describe, expect, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { renderToStaticMarkup } from "react-dom/server";
import { PerformanceGuidanceField } from "./performance-guidance-field";

function render(props: Partial<Parameters<typeof PerformanceGuidanceField>[0]> = {}) {
  return renderToStaticMarkup(
    <ChakraProvider value={system}>
      <PerformanceGuidanceField enabled qualifies minimumClips={30} canManage {...props} />
    </ChakraProvider>,
  );
}

describe("Use my performance data to pick clips", () => {
  test("says which posts count and that it refreshes daily", () => {
    const markup = render();
    expect(markup).toContain("Use my performance data to pick clips");
    expect(markup).toContain("Only clips you posted from Narriflow to TikTok and YouTube Shorts count");
    expect(markup).toContain("refreshed daily");
    expect(markup).toContain('name="enabled"');
  });

  test("on, with data, explains what it nudges", () => {
    expect(render()).toContain("It nudges which moments are found and which clips are exported first.");
  });

  test("on, without data yet, says when it takes effect instead", () => {
    const markup = render({ qualifies: false });
    expect(markup).toContain("It takes effect once 30 clips have a 7-day reading.");
    expect(markup).not.toContain("It nudges");
  });

  test("off, it does not describe what it would nudge", () => {
    const markup = render({ enabled: false });
    expect(markup).not.toContain("It nudges");
    expect(markup).toContain("Clips are picked on their own score.");
  });
});
