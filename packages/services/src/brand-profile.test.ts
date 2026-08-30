import { describe, expect, test } from "bun:test";
import { DEFAULT_CAPTION_PRESET } from "@narriflow/validators";
import {
  buildBrandProfileSnapshot,
  compatibilityProfileSlug,
  resolveProfileStyleSelection,
} from "./brand-profile.service";

const profile = {
  id: "4d119c8d-acde-4d95-82a4-0e61210e61db",
  name: "Northstar",
  revision: 3,
  visualIdentity: { primaryColor: "#102A43" },
  voiceGuidance: { tone: ["warm"] },
  approvalRule: "approval_required",
};

const template = {
  id: "e521bff1-8f56-43da-9868-1adf1d42dc5d",
  captionPreset: DEFAULT_CAPTION_PRESET,
  logoStorageKey: "brands/logo.png",
  logoPosition: "bot-right",
  logoOpacity: 80,
  logoScalePct: 15,
  primaryColor: "#102A43",
  secondaryColor: "#F0B429",
  accentColor: null,
};

describe("Brand Profile project resolution", () => {
  test("freezes versioned identity and the selected style preset", () => {
    expect(buildBrandProfileSnapshot(profile, template)).toMatchObject({
      version: 1,
      profileId: "4d119c8d-acde-4d95-82a4-0e61210e61db",
      profileRevision: 3,
      name: "Northstar",
      style: { templateId: "e521bff1-8f56-43da-9868-1adf1d42dc5d" },
    });
  });

  test("explicit profile selection requires the optional template to be a member", () => {
    expect(resolveProfileStyleSelection({ requestedTemplateId: null, defaultTemplateId: "e521bff1-8f56-43da-9868-1adf1d42dc5d", memberTemplateIds: ["e521bff1-8f56-43da-9868-1adf1d42dc5d"] })).toBe("e521bff1-8f56-43da-9868-1adf1d42dc5d");
    expect(() => resolveProfileStyleSelection({ requestedTemplateId: "other", defaultTemplateId: "e521bff1-8f56-43da-9868-1adf1d42dc5d", memberTemplateIds: ["e521bff1-8f56-43da-9868-1adf1d42dc5d"] })).toThrow();
  });

  test("uses one stable reserved compatibility slug", () => {
    expect(compatibilityProfileSlug()).toBe("migrated-brand-kit");
  });
});
