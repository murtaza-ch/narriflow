import { describe, expect, mock, test } from "bun:test";
import { ChakraProvider } from "@chakra-ui/react";
import { system } from "@narriflow/ui/theme";
import { planLimits } from "@narriflow/validators";
import { renderToStaticMarkup } from "react-dom/server";

mock.module("./studio-shell", () => ({ useStudio: () => ({}) }));

const { ResolutionChoices } = await import("./studio-export-menu");
const {
  generatedImagesExhaustedCopy,
  generatedImagesUpgradePrompt,
  resolutionAction,
  studioUpgradePrompts,
} = await import("./studio-upgrade");

describe("Studio upgrade prompts", () => {
  test("Free sees Creator locks for every plan-gated tool", () => {
    const prompts = studioUpgradePrompts("free", { requiredTier: "creator" });
    for (const key of ["export1080p", "watermark", "motion", "scenes", "censoring"] as const) {
      expect(prompts[key]?.tier).toBe("creator");
      expect(prompts[key]?.highlight).toBeTruthy();
    }
  });

  test("Creator and above have nothing locked", () => {
    const prompts = studioUpgradePrompts("creator", null);
    expect(prompts).toEqual({
      export1080p: null,
      watermark: null,
      motion: null,
      scenes: null,
      censoring: null,
    });
  });

  test("scenes follow the brand scope requirement, and none means no lock", () => {
    expect(studioUpgradePrompts("creator", { requiredTier: "pro" }).scenes?.tier).toBe("pro");
    expect(studioUpgradePrompts("free", { requiredTier: null }).scenes).toBeNull();
  });

  test("AI image upgrades need room for the next image and end at the top tier", () => {
    // Free's sample is lifetime, so only a monthly allowance is a candidate.
    expect(generatedImagesUpgradePrompt("free", 1)?.tier).toBe("creator");
    expect(generatedImagesUpgradePrompt("creator", 10)?.tier).toBe("pro");
    expect(generatedImagesUpgradePrompt("business", 60)).toBeNull();
  });

  test("AI image upgrades use actual usage after a downgrade", () => {
    // Creator after 30 images on Pro: Pro's 30 are spent, so the offer must be Business.
    const prompt = generatedImagesUpgradePrompt("creator", 30);
    expect(prompt?.tier).toBe("business");
    expect(planLimits("business").generatedImages.count).toBeGreaterThan(30);
    expect(generatedImagesUpgradePrompt("pro", 60)).toBeNull();
    expect(generatedImagesUpgradePrompt("creator", 60)).toBeNull();
  });

  test("Free's exhausted sample is lifetime; a paid month renews", () => {
    const prompt = generatedImagesUpgradePrompt("free", 1);
    const lifetime = generatedImagesExhaustedCopy({ period: "lifetime", renewsAt: null }, prompt);
    expect(lifetime.message).toContain("sample");
    expect(lifetime.message).not.toContain("period");
    expect(lifetime.upgrade).toBe(true);
    const monthly = generatedImagesExhaustedCopy({ period: "month", renewsAt: "2026-11-01T00:00:00.000Z" }, null);
    expect(monthly.message).toContain("renew on Nov 1");
    expect(monthly.upgrade).toBe(false);
  });
});

describe("Resolution choices", () => {
  test("a locked 1080p never selects", () => {
    expect(resolutionAction("1080p", false)).toBe("upgrade");
    expect(resolutionAction("1080p", true)).toBe("select");
    expect(resolutionAction("720p", false)).toBe("select");
  });

  test("locked 1080p stays visible with a gem and the required plan", () => {
    const prompt = studioUpgradePrompts("free", null).export1080p;
    const markup = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <ResolutionChoices can1080pExport={false} prompt={prompt} resolution="720p" onSelect={() => undefined} onUpgrade={() => undefined} />
      </ChakraProvider>,
    );
    expect(markup).toContain("1080p");
    expect(markup).toContain("needs Creator");
    expect(markup).toContain('aria-haspopup="dialog"');
  });

  test("entitled 1080p shows no lock", () => {
    const markup = renderToStaticMarkup(
      <ChakraProvider value={system}>
        <ResolutionChoices can1080pExport prompt={null} resolution="1080p" onSelect={() => undefined} onUpgrade={() => undefined} />
      </ChakraProvider>,
    );
    expect(markup).not.toContain("needs");
  });
});
