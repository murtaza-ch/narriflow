import { createHash, randomUUID } from "node:crypto";
import {
  SOCIAL_PROVIDER_CAPABILITIES,
	socialProviderAcceptsCustomThumbnail,
	socialProviderAcceptsMedia,
  type ClipAspectRatio,
  type ClipRenderResolution,
  type SocialProviderCapabilityPlatform,
} from "@narriflow/validators";
import {
  CalendarTimeError,
  workspaceLocalDateTimeToUtc,
} from "./calendar-time";
import type { AssistedCopyContent } from "./assisted-copy.service";
import type { ReviewApprovalPrincipal } from "./review-approval.service";

export interface BulkSchedulingScope {
  actorUserId: string;
  ownerUserId: string;
  workspaceId: string;
  projectId: string;
  approvalPrincipal: ReviewApprovalPrincipal;
}

export interface BulkSchedulingAccount {
  id: string;
  workspaceId: string;
  platform: SocialProviderCapabilityPlatform;
  status: "active" | "expired" | "revoked";
  expiresAt: Date | null;
  refreshable: boolean;
}

export interface BulkSchedulingCopyDraft {
  id: string;
  workspaceId: string;
  projectId: string;
  clipId: string;
  platform: SocialProviderCapabilityPlatform;
  status: "generating" | "completed" | "rejected" | "failed" | "unknown";
  revision: number;
  confirmed: boolean;
  content: AssistedCopyContent | null;
}

export interface BulkSchedulingThumbnail {
  id: string;
  workspaceId: string;
	kind: "image" | "video";
	contentType: string;
	sizeBytes: number;
	fingerprint: string;
  provenance: "uploaded" | "generated" | "extracted";
  sourceExportVariantId: string | null;
	sourceTimeMs: number | null;
  deletedAt: Date | null;
}

export interface BulkScheduleItemInput {
  itemKey: string;
  occurrenceIndex: number;
  clipId: string;
  expectedEditorRevision: number;
  exportVariantId: string;
  accountId: string;
  platform: SocialProviderCapabilityPlatform;
  assistedCopyDraftId: string;
  assistedCopyRevision: number;
  aspectRatio: ClipAspectRatio;
  resolution: ClipRenderResolution;
	durationSec: number;
  thumbnailAssetId: string | null;
  approvalOverrideReason?: string | null;
}

export interface BulkScheduleInput {
  idempotencyKey: string;
  timezone: string;
  startDate: string;
  postingWindow: {
    startTime: string;
    endTime: string;
    frequencyMinutes: number;
  };
  items: BulkScheduleItemInput[];
}

export interface BulkScheduleItemResult {
  itemKey: string;
  clipId: string;
  accountId: string;
  status: "scheduled" | "failed";
  postId: string | null;
  scheduledFor: string | null;
  errorCode: string | null;
}

export interface BulkScheduleResult {
  operationId: string;
  status: "completed" | "partial" | "failed";
  counts: { scheduled: number; failed: number };
  items: BulkScheduleItemResult[];
  replayed: boolean;
}

export type StoredBulkScheduleResult = Omit<BulkScheduleResult, "replayed">;

export interface BulkSchedulingStore {
  readAccount(input: BulkSchedulingScope & { accountId: string }): Promise<BulkSchedulingAccount | null>;
  readCopy(input: BulkSchedulingScope & { draftId: string }): Promise<BulkSchedulingCopyDraft | null>;
  readThumbnail(input: BulkSchedulingScope & { assetId: string }): Promise<BulkSchedulingThumbnail | null>;
  open(input: {
    actorUserId: string;
    workspaceId: string;
    projectId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    requestedCount: number;
    execute(operationId: string): Promise<StoredBulkScheduleResult>;
  }): Promise<{ result: StoredBulkScheduleResult; replayed: boolean }>;
}

export interface BulkPublicationScheduler {
  schedule(input: {
    itemKey: string;
    actorUserId: string;
    ownerUserId: string;
    workspaceId: string;
    projectId: string;
    clientIdempotencyKey: string;
    clipId: string;
    expectedEditorRevision: number;
    exportVariantId: string;
    accountId: string;
    platform: SocialProviderCapabilityPlatform;
    caption: string;
    aspectRatio: ClipAspectRatio;
    resolution: ClipRenderResolution;
		durationSec: number;
    scheduledFor: Date;
    providerSettings: Record<string, unknown>;
    assistedCopyDraftId: string;
    assistedCopyRevision: number;
    approvalOverrideReason: string | null;
    approvalPrincipal: ReviewApprovalPrincipal;
  }): Promise<{ postId: string; status: "scheduled" | "preparing_video" }>;
}

export class BulkSchedulingError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BulkSchedulingError";
  }
}

export class BulkScheduleItemError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "BulkScheduleItemError";
  }
}

export class BulkScheduleReconciliationRequiredError extends Error {
  readonly code = "bulk_schedule_publication_reconciliation_required";

  constructor() {
    super("Publication scheduling has an unknown commit outcome; replay this bulk request");
    this.name = "BulkScheduleReconciliationRequiredError";
  }
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function requestFingerprint(scope: BulkSchedulingScope, input: BulkScheduleInput) {
  return createHash("sha256")
    .update(
      canonicalJson({
        contract: "bulk-scheduling-v1",
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        ...input,
      }),
    )
    .digest("hex");
}

function deterministicUuid(...parts: string[]) {
  const value = createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
  return `${value.slice(0, 8)}-${value.slice(8, 12)}-4${value.slice(13, 16)}-8${value.slice(17, 20)}-${value.slice(20, 32)}`;
}

function parseMinutes(value: string, code: string) {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new BulkSchedulingError(code, "Posting windows use 24-hour HH:mm values");
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) {
    throw new BulkSchedulingError(code, "Posting windows use valid 24-hour times");
  }
  return hours * 60 + minutes;
}

function localDateAfter(startDate: string, days: number) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(startDate);
  if (!match) throw new BulkSchedulingError("bulk_schedule_start_date_invalid", "Choose a valid start date");
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    date.getUTCFullYear() !== Number(match[1]) ||
    date.getUTCMonth() !== Number(match[2]) - 1 ||
    date.getUTCDate() !== Number(match[3])
  ) {
    throw new BulkSchedulingError("bulk_schedule_start_date_invalid", "Choose a valid start date");
  }
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
}

function slots(input: BulkScheduleInput) {
  const start = parseMinutes(input.postingWindow.startTime, "bulk_schedule_window_invalid");
  const end = parseMinutes(input.postingWindow.endTime, "bulk_schedule_window_invalid");
  const frequency = input.postingWindow.frequencyMinutes;
  if (!Number.isInteger(frequency) || frequency < 5 || frequency > 1_440 || end <= start) {
    throw new BulkSchedulingError(
      "bulk_schedule_window_invalid",
      "Choose a forward posting window and a frequency between 5 minutes and 24 hours",
    );
  }
  const minutes: number[] = [];
  for (let minute = start; minute < end; minute += frequency) minutes.push(minute);
  if (minutes.length === 0) {
    throw new BulkSchedulingError("bulk_schedule_window_invalid", "The posting window has no usable slots");
  }
  return input.items.map((item) => {
    const day = Math.floor(item.occurrenceIndex / minutes.length);
    const minute = minutes[item.occurrenceIndex % minutes.length]!;
    return `${localDateAfter(input.startDate, day)}T${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  });
}

function finalCaption(content: AssistedCopyContent) {
  const tags = content.hashtags.map((tag) => `#${tag.replace(/^#/, "")}`).join(" ");
  return tags ? `${content.caption.trim()}\n\n${tags}` : content.caption.trim();
}

function failure(input: BulkScheduleItemInput, errorCode: string, scheduledFor: Date | null): BulkScheduleItemResult {
  return {
    itemKey: input.itemKey,
    clipId: input.clipId,
    accountId: input.accountId,
    status: "failed",
    postId: null,
    scheduledFor: scheduledFor?.toISOString() ?? null,
    errorCode,
  };
}

export function createBulkSchedulingService(dependencies: {
  store: BulkSchedulingStore;
  scheduler: BulkPublicationScheduler;
  authorize(scope: BulkSchedulingScope): Promise<void>;
  diagnostics?: (event: Record<string, unknown>) => void;
  now?: () => Date;
}) {
  const now = dependencies.now ?? (() => new Date());
  const diagnostics = dependencies.diagnostics ?? (() => undefined);

  return {
    async schedule(scope: BulkSchedulingScope, input: BulkScheduleInput): Promise<BulkScheduleResult> {
      await dependencies.authorize(scope);
      if (input.items.length < 1 || input.items.length > 100) {
        throw new BulkSchedulingError(
          "bulk_schedule_item_count_invalid",
          "Bulk scheduling accepts between 1 and 100 items",
        );
      }
      if (new Set(input.items.map((item) => item.itemKey)).size !== input.items.length) {
        throw new BulkSchedulingError(
          "bulk_schedule_item_key_duplicate",
          "Every scheduling item needs a unique item key",
        );
      }
      if (
        input.items.some(
          (item) =>
            !Number.isInteger(item.occurrenceIndex) ||
            item.occurrenceIndex < 0 ||
            item.occurrenceIndex >= 100,
        ) ||
        new Set(input.items.map((item) => item.occurrenceIndex)).size !==
          input.items.length
      ) {
        throw new BulkSchedulingError(
          "bulk_schedule_occurrence_invalid",
          "Every scheduling item needs one unique occurrence from 0 through 99",
        );
      }
      const localSlots = slots(input);
      const opened = await dependencies.store.open({
        actorUserId: scope.actorUserId,
        workspaceId: scope.workspaceId,
        projectId: scope.projectId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: requestFingerprint(scope, input),
        requestedCount: input.items.length,
        execute: async (operationId) => {
          const items: BulkScheduleItemResult[] = [];
          for (const [index, item] of input.items.entries()) {
            let scheduledFor: Date | null = null;
            try {
              scheduledFor = workspaceLocalDateTimeToUtc(localSlots[index]!, input.timezone);
              if (scheduledFor <= now()) {
                throw new BulkScheduleItemError(
                  "publication_schedule_in_past",
                  "Choose a future posting window",
                );
              }
              const [account, copy, thumbnail] = await Promise.all([
                dependencies.store.readAccount({ ...scope, accountId: item.accountId }),
                dependencies.store.readCopy({ ...scope, draftId: item.assistedCopyDraftId }),
                item.thumbnailAssetId
                  ? dependencies.store.readThumbnail({ ...scope, assetId: item.thumbnailAssetId })
                  : Promise.resolve(null),
              ]);
              if (!account || account.platform !== item.platform) {
                throw new BulkScheduleItemError(
                  "bulk_schedule_account_invalid",
                  "The destination account is unavailable for this platform",
                );
              }
              if (
                account.status !== "active" ||
				(!account.refreshable &&
					account.expiresAt !== null &&
					account.expiresAt <= scheduledFor)
              ) {
                throw new BulkScheduleItemError(
                  "bulk_schedule_account_expired",
                  "Reconnect the destination account before scheduling",
                );
              }
              if (
                !copy ||
                copy.clipId !== item.clipId ||
                copy.platform !== item.platform ||
                copy.status !== "completed" ||
                !copy.confirmed ||
                copy.revision !== item.assistedCopyRevision ||
                !copy.content
              ) {
                throw new BulkScheduleItemError(
                  "bulk_schedule_copy_unconfirmed",
                  "Confirm the current assisted-copy revision before scheduling",
                );
              }
              const capability = SOCIAL_PROVIDER_CAPABILITIES[item.platform];
              if (!(capability.aspectRatios as readonly string[]).includes(item.aspectRatio)) {
                throw new BulkScheduleItemError(
                  "bulk_schedule_aspect_ratio_unsupported",
                  "The destination does not accept this export aspect ratio",
                );
              }
							if (!socialProviderAcceptsMedia({
								platform: item.platform,
								aspectRatio: item.aspectRatio,
								durationSec: item.durationSec,
							})) {
								throw new BulkScheduleItemError(
									"bulk_schedule_media_unsupported",
									"The destination does not accept this export duration",
								);
							}
              const caption = finalCaption(copy.content);
              if (!caption || caption.length > capability.textLimit) {
                throw new BulkScheduleItemError(
                  "bulk_schedule_text_invalid",
                  "The confirmed copy exceeds the destination text limit",
                );
              }
              let thumbnailType: "custom_image" | "video_frame" | null = null;
              if (item.thumbnailAssetId) {
                if (!thumbnail || thumbnail.deletedAt) {
                  throw new BulkScheduleItemError(
                    "bulk_schedule_thumbnail_missing",
                    "The selected thumbnail asset is unavailable",
                  );
                }
								if (thumbnail.kind !== "image") {
									throw new BulkScheduleItemError(
										"bulk_schedule_thumbnail_invalid",
										"The selected thumbnail must be a supported image asset",
									);
                }
                thumbnailType = thumbnail.provenance === "extracted" ? "video_frame" : "custom_image";
								if (!(capability.thumbnailTypes as readonly string[]).includes(thumbnailType)) {
									throw new BulkScheduleItemError(
										"bulk_schedule_thumbnail_unsupported",
										"The destination does not accept this thumbnail source",
									);
								}
								if (
									(thumbnailType === "custom_image" &&
										!socialProviderAcceptsCustomThumbnail({
											platform: item.platform,
											contentType: thumbnail.contentType,
											sizeBytes: thumbnail.sizeBytes,
										})) ||
									(thumbnailType === "video_frame" && thumbnail.sourceTimeMs === null)
								) {
									throw new BulkScheduleItemError(
										"bulk_schedule_thumbnail_invalid",
										"The selected thumbnail does not satisfy the provider media contract",
									);
								}
                if (
                  thumbnail.provenance === "extracted" &&
                  thumbnail.sourceExportVariantId !== item.exportVariantId
                ) {
                  throw new BulkScheduleItemError(
                    "bulk_schedule_thumbnail_export_mismatch",
                    "The extracted frame belongs to a different immutable export",
                  );
                }
              }
              const providerSettings: Record<string, unknown> = {
                ...(capability.titleField && copy.content.title
                  ? { title: copy.content.title }
                  : {}),
                ...(thumbnailType && item.thumbnailAssetId
					? {
						thumbnailType,
						thumbnailAssetId: item.thumbnailAssetId,
						thumbnailFingerprint: thumbnail!.fingerprint,
						...(thumbnail!.sourceTimeMs === null
							? {}
							: { thumbnailSourceTimeMs: thumbnail!.sourceTimeMs }),
					}
                  : {}),
              };
              const scheduled = await dependencies.scheduler.schedule({
                ...scope,
                itemKey: item.itemKey,
                clientIdempotencyKey: deterministicUuid(operationId, item.itemKey),
                clipId: item.clipId,
                expectedEditorRevision: item.expectedEditorRevision,
                exportVariantId: item.exportVariantId,
                accountId: item.accountId,
                platform: item.platform,
                caption,
                aspectRatio: item.aspectRatio,
                resolution: item.resolution,
				durationSec: item.durationSec,
                scheduledFor,
                providerSettings,
                assistedCopyDraftId: item.assistedCopyDraftId,
                assistedCopyRevision: item.assistedCopyRevision,
                approvalOverrideReason: item.approvalOverrideReason?.trim() || null,
              });
              items.push({
                itemKey: item.itemKey,
                clipId: item.clipId,
                accountId: item.accountId,
                status: "scheduled",
                postId: scheduled.postId,
                scheduledFor: scheduledFor.toISOString(),
                errorCode: null,
              });
            } catch (error) {
              if (error instanceof BulkScheduleReconciliationRequiredError) {
                throw error;
              }
              const errorCode =
                error instanceof CalendarTimeError ||
                error instanceof BulkScheduleItemError
                  ? error.code
                  : typeof error === "object" &&
                      error !== null &&
                      "code" in error &&
                      typeof error.code === "string"
                    ? error.code
                    : "bulk_schedule_item_failed";
              items.push(failure(item, errorCode, scheduledFor));
            }
          }
          const scheduled = items.filter((item) => item.status === "scheduled").length;
          const failed = items.length - scheduled;
          const result: StoredBulkScheduleResult = {
            operationId,
            status: failed === 0 ? "completed" : scheduled === 0 ? "failed" : "partial",
            counts: { scheduled, failed },
            items,
          };
          diagnostics({
            event: "bulk_schedule_settled",
            workspaceId: scope.workspaceId,
            projectId: scope.projectId,
            operationId,
            status: result.status,
            scheduledCount: scheduled,
            failedCount: failed,
            errorCodes: items.flatMap((item) => item.errorCode ?? []),
          });
          return result;
        },
      });
      return { ...opened.result, replayed: opened.replayed };
    },
  };
}

export function createInMemoryBulkSchedulingStore(input: {
  accounts: BulkSchedulingAccount[];
  copyDrafts: BulkSchedulingCopyDraft[];
  thumbnailAssets: BulkSchedulingThumbnail[];
}) {
  const accounts = new Map(input.accounts.map((account) => [account.id, structuredClone(account)]));
  const copyDrafts = new Map(input.copyDrafts.map((draft) => [draft.id, structuredClone(draft)]));
  const thumbnails = new Map(input.thumbnailAssets.map((asset) => [asset.id, structuredClone(asset)]));
  const operations = new Map<
    string,
    { requestFingerprint: string; promise: Promise<StoredBulkScheduleResult> }
  >();
  const operationKey = (workspaceId: string, projectId: string, idempotencyKey: string) =>
    `${workspaceId}:${projectId}:${idempotencyKey}`;

  const store: BulkSchedulingStore & {
    expireAccount(id: string, expiresAt: Date): void;
    unconfirmCopy(id: string): void;
    addThumbnail(asset: BulkSchedulingThumbnail): void;
  } = {
    expireAccount(id, expiresAt) {
      const account = accounts.get(id);
      if (account) accounts.set(id, { ...account, expiresAt, status: "expired" });
    },
    unconfirmCopy(id) {
      const copy = copyDrafts.get(id);
      if (copy) copyDrafts.set(id, { ...copy, confirmed: false });
    },
    addThumbnail(asset) {
      thumbnails.set(asset.id, structuredClone(asset));
    },
    async readAccount(query) {
      const account = accounts.get(query.accountId);
      return account && account.workspaceId === query.workspaceId
        ? structuredClone(account)
        : null;
    },
    async readCopy(query) {
      const copy = copyDrafts.get(query.draftId);
      return copy &&
        copy.workspaceId === query.workspaceId &&
        copy.projectId === query.projectId
        ? structuredClone(copy)
        : null;
    },
    async readThumbnail(query) {
      const asset = thumbnails.get(query.assetId);
      return asset && asset.workspaceId === query.workspaceId
        ? structuredClone(asset)
        : null;
    },
    async open(openInput) {
      const key = operationKey(
        openInput.workspaceId,
        openInput.projectId,
        openInput.idempotencyKey,
      );
      const existing = operations.get(key);
      if (existing) {
        if (existing.requestFingerprint !== openInput.requestFingerprint) {
          throw new BulkSchedulingError(
            "bulk_schedule_idempotency_conflict",
            "The idempotency key was already used with different scheduling inputs",
          );
        }
        return { result: structuredClone(await existing.promise), replayed: true };
      }
      const operationId = randomUUID();
      const promise = openInput.execute(operationId);
      operations.set(key, { requestFingerprint: openInput.requestFingerprint, promise });
      try {
        return { result: structuredClone(await promise), replayed: false };
      } catch (error) {
        operations.delete(key);
        throw error;
      }
    },
  };
  return store;
}
