import { describe, expect, test } from "bun:test";

import { AssistedCopyError } from "./assisted-copy.service";
import {
  BUSINESS_AUTOMATION_FAILURE_MESSAGE,
  businessAutomationDomainErrorCode,
} from "./business-automation-error";
import { BulkSchedulingError } from "./bulk-scheduling.service";
import { CampaignOperationError } from "./campaign-operation.service";
import { GeneratedMediaError } from "./generated-media";
import { AssistedCopyProviderConfigurationError } from "./openai-assisted-copy.provider";
import { ProgramWriteDisabledError } from "./program-rollout";
import { ReviewServiceError } from "./review.service";
import { ThumbnailExtractionError } from "./thumbnail-extraction.service";

describe("Business automation public failures", () => {
  test.each([
    [new CampaignOperationError("campaign_operation_conflict", "private"), "campaign_operation_conflict"],
    [new ReviewServiceError("review_delivery_unavailable", "private"), "review_delivery_unavailable"],
    [new AssistedCopyError("assisted_copy_failed", "private"), "assisted_copy_failed"],
    [new AssistedCopyProviderConfigurationError(), "assisted_copy_provider_unconfigured"],
    [new ThumbnailExtractionError("thumbnail_worker_required", "private"), "thumbnail_worker_required"],
    [new BulkSchedulingError("bulk_schedule_conflict", "private"), "bulk_schedule_conflict"],
    [new GeneratedMediaError("generated_media_not_configured"), "generated_media_not_configured"],
    [new ProgramWriteDisabledError("bulk_scheduling"), "program_write_disabled"],
  ])("maps a known domain family to its stable code", (error, expected) => {
    expect(businessAutomationDomainErrorCode(error)).toBe(expected);
  });

  test("does not trust arbitrary code-shaped errors", () => {
    const error = Object.assign(new Error("private customer text"), {
      code: "generated_media_customer_secret",
    });
    expect(businessAutomationDomainErrorCode(error)).toBeNull();
    expect(BUSINESS_AUTOMATION_FAILURE_MESSAGE).not.toContain("customer");
  });
});
