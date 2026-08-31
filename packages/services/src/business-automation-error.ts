import {
  BrandProfileConflictError,
  BrandProfileMembershipError,
  BrandProfileMissingAssetError,
  BrandProfileNotFoundError,
  BrandProfileReferenceError,
} from "./brand-profile.service";
import { AssistedCopyError } from "./assisted-copy.service";
import { BulkSchedulingError } from "./bulk-scheduling.service";
import { CampaignOperationError } from "./campaign-operation.service";
import { GeneratedMediaError } from "./generated-media";
import { AssistedCopyProviderConfigurationError } from "./openai-assisted-copy.provider";
import { ProgramWriteDisabledError } from "./program-rollout";
import {
  ReviewApprovalOverrideConflictError,
  ReviewApprovalRequiredError,
  ReviewApprovalTargetError,
  ReviewOverrideForbiddenError,
} from "./review-approval.service";
import { ReviewServiceError } from "./review.service";
import { ThumbnailExtractionError } from "./thumbnail-extraction.service";

export const BUSINESS_AUTOMATION_FAILURE_MESSAGE =
  "Workflow request could not be completed";

export function businessAutomationDomainErrorCode(
  error: unknown,
): string | null {
  if (
    error instanceof BrandProfileConflictError ||
    error instanceof BrandProfileMembershipError ||
    error instanceof BrandProfileMissingAssetError ||
    error instanceof BrandProfileNotFoundError ||
    error instanceof BrandProfileReferenceError ||
    error instanceof CampaignOperationError ||
    error instanceof ReviewServiceError ||
    error instanceof ReviewApprovalRequiredError ||
    error instanceof ReviewOverrideForbiddenError ||
    error instanceof ReviewApprovalOverrideConflictError ||
    error instanceof ReviewApprovalTargetError ||
    error instanceof AssistedCopyError ||
    error instanceof AssistedCopyProviderConfigurationError ||
    error instanceof ThumbnailExtractionError ||
    error instanceof BulkSchedulingError ||
    error instanceof GeneratedMediaError ||
    error instanceof ProgramWriteDisabledError
  ) {
    return error.code;
  }
  return null;
}
