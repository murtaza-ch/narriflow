import { createHash } from "node:crypto";
import type {
  ClipAspectRatio,
  ClipRenderResolution,
  SocialPlatform,
} from "@narriflow/validators";
import type { ThumbnailSelection } from "./thumbnail-frame-preparation";
import {
  ExpectedDomainFailureError,
  type ExpectedDomainFailureCatalog,
} from "./expected-domain-failure";

export type BulkScheduleCopy = {
  variantId: string;
  caption: string;
  hashtags: string[];
  title: string | null;
  providerSettings?: Record<string, unknown>;
};

export type BulkSocialScheduleInput = {
  actorUserId: string;
  workspaceId: string;
  projectId: string;
  idempotencyKey: string;
  accounts: Array<{ accountId: string; platform: SocialPlatform }>;
  clips: Array<{
    clipId: string;
    expectedEditorRevision: number;
		exportId: string;
		exportVariantId: string;
    aspectRatio: ClipAspectRatio;
    resolution: ClipRenderResolution;
    copyByPlatform: Partial<Record<SocialPlatform, BulkScheduleCopy>>;
    thumbnailByPlatform: Partial<Record<SocialPlatform, ThumbnailSelection | null>>;
  }>;
  startDate: string;
  timeZone: string;
  postingWindow: { start: string; end: string };
  frequency: { unit: "hours" | "days"; value: number };
  dstDisambiguation: "earlier" | "later" | null;
	reviewOverrideReason?: string | null;
};

export type BulkScheduleItem = {
  id: string;
  requestKey: string;
  clipId: string;
  expectedEditorRevision: number;
  accountId: string;
  platform: SocialPlatform;
  scheduledFor: Date | null;
  status: "pending" | "processing" | "succeeded" | "ineligible" | "failed";
  errorCode: string | null;
  retryable: boolean;
  socialPostId: string | null;
};

export type BulkScheduleOperation = {
  id: string;
  workspaceId: string;
  projectId: string;
  idempotencyKey: string;
  requestFingerprint: string;
  status: "running" | "completed" | "partial" | "failed";
  items: BulkScheduleItem[];
  createdAt: Date;
  completedAt: Date | null;
};

export interface BulkScheduleStore {
  open(input: {
    workspaceId: string;
    projectId: string;
    idempotencyKey: string;
    requestFingerprint: string;
    actorUserId: string;
    pricingTier: string;
    validatedOptions: Record<string, unknown>;
    create(): BulkScheduleOperation;
  }): Promise<{ operation: BulkScheduleOperation; replayed: boolean }>;
  claimItem(
		operationId: string,
		requestKey: string,
	): Promise<{ item: BulkScheduleItem; claimToken: string } | null>;
  settleItem(
    operationId: string,
    requestKey: string,
		claimToken: string,
    patch: Pick<
      BulkScheduleItem,
      "status" | "errorCode" | "retryable" | "socialPostId"
    >,
  ): Promise<void>;
  settleOperation(operationId: string, now: Date): Promise<BulkScheduleOperation>;
}

const BULK_SOCIAL_SCHEDULING_FAILURES = {
  campaign_schedule_claim_lost: "conflict",
  campaign_schedule_duplicate_account: "invalid",
  campaign_schedule_duplicate_clip: "invalid",
  campaign_schedule_clip_not_found: "missing",
  campaign_schedule_entitlement_required: "forbidden",
  campaign_schedule_idempotency_conflict: "conflict",
  campaign_schedule_input_invalid: "invalid",
  campaign_schedule_item_incomplete: "conflict",
  campaign_schedule_item_not_found: "missing",
  campaign_schedule_item_failed: "unavailable",
  campaign_schedule_not_found: "missing",
  campaign_schedule_too_many_items: "invalid",
  publication_provider_rate_limited: "rate_limited",
  review_approval_required: "conflict",
  schedule_date_invalid: "invalid",
  schedule_frequency_invalid: "invalid",
  schedule_local_time_ambiguous: "conflict",
  schedule_local_time_nonexistent: "invalid",
  schedule_time_invalid: "invalid",
  schedule_timezone_invalid: "invalid",
  schedule_timezone_mismatch: "invalid",
  schedule_window_invalid: "invalid",
  social_account_expired: "forbidden",
  workspace_not_found: "missing",
} as const satisfies ExpectedDomainFailureCatalog<string>;

export type BulkSocialSchedulingErrorCode = keyof typeof BULK_SOCIAL_SCHEDULING_FAILURES;

export class BulkSocialSchedulingError extends ExpectedDomainFailureError<BulkSocialSchedulingErrorCode> {
  constructor(
    code: BulkSocialSchedulingErrorCode,
    message: string = code,
    readonly retryable = false,
  ) {
    super({
      code,
      kind: BULK_SOCIAL_SCHEDULING_FAILURES[code],
      message,
      details: retryable ? { retryable: true } : undefined,
    });
    this.name = "BulkSocialSchedulingError";
  }
}

type LocalDate = { year: number; month: number; day: number };
type LocalTime = { hour: number; minute: number };

function parseDate(value: string): LocalDate {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) throw new BulkSocialSchedulingError("schedule_date_invalid");
  const result = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const normalized = new Date(Date.UTC(result.year, result.month - 1, result.day));
  if (
    normalized.getUTCFullYear() !== result.year ||
    normalized.getUTCMonth() + 1 !== result.month ||
    normalized.getUTCDate() !== result.day
  ) {
    throw new BulkSocialSchedulingError("schedule_date_invalid");
  }
  return result;
}

function parseTime(value: string): LocalTime {
  const match = /^(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new BulkSocialSchedulingError("schedule_time_invalid");
  const result = { hour: Number(match[1]), minute: Number(match[2]) };
  if (result.hour > 23 || result.minute > 59) {
    throw new BulkSocialSchedulingError("schedule_time_invalid");
  }
  return result;
}

function formatParts(epochMs: number, timeZone: string) {
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new BulkSocialSchedulingError("schedule_timezone_invalid");
  }
  const parts = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs)).map((part) => [part.type, part.value]),
  );
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

export function resolveWorkspaceLocalDateTime(input: {
  date: string;
  time: string;
  timeZone: string;
  disambiguation: "earlier" | "later" | null;
}): Date {
  const date = parseDate(input.date);
  const time = parseTime(input.time);
  const naive = Date.UTC(date.year, date.month - 1, date.day, time.hour, time.minute);
  const offsets = new Set<number>();
  for (let deltaHours = -24; deltaHours <= 24; deltaHours += 1) {
    const epoch = naive + deltaHours * 60 * 60_000;
    const local = formatParts(epoch, input.timeZone);
    const localAsUtc = Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute);
    offsets.add(localAsUtc - epoch);
  }
  const candidates = [...offsets]
    .map((offset) => naive - offset)
    .filter((epoch) => {
      const local = formatParts(epoch, input.timeZone);
      return local.year === date.year && local.month === date.month && local.day === date.day &&
        local.hour === time.hour && local.minute === time.minute;
    })
    .filter((epoch, index, all) => all.indexOf(epoch) === index)
    .sort((left, right) => left - right);
  if (candidates.length === 0) {
    throw new BulkSocialSchedulingError(
      "schedule_local_time_nonexistent",
      "This local time does not exist because the clock moves forward. Choose another time.",
    );
  }
  if (candidates.length > 1 && input.disambiguation === null) {
    throw new BulkSocialSchedulingError(
      "schedule_local_time_ambiguous",
      "This local time occurs twice because the clock moves back. Choose the first or second occurrence.",
    );
  }
  return new Date(
    input.disambiguation === "later"
      ? candidates[candidates.length - 1]!
      : candidates[0]!,
  );
}

function addDays(date: LocalDate, count: number): LocalDate {
  const next = new Date(Date.UTC(date.year, date.month - 1, date.day + count));
  return {
    year: next.getUTCFullYear(),
    month: next.getUTCMonth() + 1,
    day: next.getUTCDate(),
  };
}

function isoDate(date: LocalDate) {
  return `${String(date.year).padStart(4, "0")}-${String(date.month).padStart(2, "0")}-${String(date.day).padStart(2, "0")}`;
}

function isoTime(minutes: number) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function postingSlots(input: BulkSocialScheduleInput) {
  if (!Number.isInteger(input.frequency.value) || input.frequency.value < 1 || input.frequency.value > 30) {
    throw new BulkSocialSchedulingError("schedule_frequency_invalid");
  }
  const start = parseTime(input.postingWindow.start);
  const end = parseTime(input.postingWindow.end);
  const startMinute = start.hour * 60 + start.minute;
  const endMinute = end.hour * 60 + end.minute;
  if (endMinute <= startMinute) {
    throw new BulkSocialSchedulingError("schedule_window_invalid");
  }
  let date = parseDate(input.startDate);
  let minute = startMinute;
  const slots: Date[] = [];
  for (let index = 0; index < input.clips.length; index += 1) {
    slots.push(resolveWorkspaceLocalDateTime({
      date: isoDate(date),
      time: isoTime(minute),
      timeZone: input.timeZone,
      disambiguation: input.dstDisambiguation,
    }));
    if (input.frequency.unit === "days") {
      date = addDays(date, input.frequency.value);
      minute = startMinute;
      continue;
    }
    minute += input.frequency.value * 60;
    if (minute > endMinute) {
      date = addDays(date, 1);
      minute = startMinute;
    }
  }
  return slots;
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

function sha256(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function bulkScheduleDeterministicUuid(value: string) {
  const hex = createHash("sha256").update(value).digest("hex").slice(0, 32).split("");
  hex[12] = "5";
  hex[16] = ((Number.parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  const joined = hex.join("");
  return `${joined.slice(0, 8)}-${joined.slice(8, 12)}-${joined.slice(12, 16)}-${joined.slice(16, 20)}-${joined.slice(20)}`;
}

function publicOperation(operation: BulkScheduleOperation, replayed: boolean) {
  const { requestFingerprint: _requestFingerprint, ...result } = operation;
  const counts = result.items.reduce(
    (total, item) => {
      if (item.status === "succeeded") total.succeeded += 1;
      else if (item.status === "ineligible") total.ineligible += 1;
      else if (item.status === "failed") total.failed += 1;
      return total;
    },
    { succeeded: 0, ineligible: 0, failed: 0 },
  );
  return { ...result, counts, replayed };
}

function validateInput(input: BulkSocialScheduleInput) {
  if (input.clips.length === 0 || input.clips.length > 100 || input.accounts.length === 0 || input.accounts.length > 20) {
    throw new BulkSocialSchedulingError("campaign_schedule_input_invalid");
  }
  if (new Set(input.clips.map((clip) => clip.clipId)).size !== input.clips.length) {
    throw new BulkSocialSchedulingError("campaign_schedule_duplicate_clip");
  }
  if (new Set(input.accounts.map((account) => account.accountId)).size !== input.accounts.length) {
    throw new BulkSocialSchedulingError("campaign_schedule_duplicate_account");
  }
  if (input.clips.length * input.accounts.length > 500) {
    throw new BulkSocialSchedulingError("campaign_schedule_too_many_items");
  }
}

export function createBulkSocialScheduling(dependencies: {
  store: BulkScheduleStore;
  authorize(input: {
    actorUserId: string;
    workspaceId: string;
		projectId: string;
		clipIds: string[];
    permission: "publishing.manage";
  }): Promise<{ pricingTier: string; timeZone: string }>;
  schedule(input: {
    actorUserId: string;
    workspaceId: string;
    projectId: string;
    clientIdempotencyKey: string;
    clipId: string;
    expectedEditorRevision: number;
		clipExportId: string;
		clipExportVariantId: string;
    accountId: string;
    platform: SocialPlatform;
    caption: string;
    hashtags: string[];
    title: string | null;
    providerSettings: Record<string, unknown>;
    assistedCopyVariantId: string;
    aspectRatio: ClipAspectRatio;
    resolution: ClipRenderResolution;
    thumbnail: ThumbnailSelection | null;
    scheduledFor: Date;
		reviewOverrideReason?: string | null;
  }): Promise<{ socialPostId: string; status: "preparing_video" | "scheduled" }>;
  createId(): string;
  now(): Date;
}) {
  return {
    async schedule(input: BulkSocialScheduleInput) {
      validateInput(input);
      const access = await dependencies.authorize({
        actorUserId: input.actorUserId,
        workspaceId: input.workspaceId,
				projectId: input.projectId,
				clipIds: input.clips.map((clip) => clip.clipId),
        permission: "publishing.manage",
      });
      if (input.timeZone !== access.timeZone) {
        throw new BulkSocialSchedulingError(
          "schedule_timezone_mismatch",
          "Use the workspace timezone shown in the scheduling form",
        );
      }
      const slots = postingSlots(input);
      const requestFingerprint = sha256({ contract: "campaign-schedule-v1", ...input });
      const plans = input.clips.flatMap((clip, clipIndex) =>
        input.accounts.map((account) => {
          const scheduledFor = slots[clipIndex]!;
          const requestKey = sha256({
            clipId: clip.clipId,
            accountId: account.accountId,
            scheduledFor: scheduledFor.toISOString(),
          });
          return {
            requestKey,
            clip,
            account,
            scheduledFor,
            copy: clip.copyByPlatform[account.platform] ?? null,
            thumbnail: clip.thumbnailByPlatform[account.platform] ?? null,
          };
        }),
      );
      const opened = await dependencies.store.open({
        workspaceId: input.workspaceId,
        projectId: input.projectId,
        idempotencyKey: input.idempotencyKey,
        requestFingerprint,
        actorUserId: input.actorUserId,
        pricingTier: access.pricingTier,
        validatedOptions: {
          startDate: input.startDate,
          timeZone: input.timeZone,
          postingWindow: input.postingWindow,
          frequency: input.frequency,
          dstDisambiguation: input.dstDisambiguation,
			reviewOverrideReason: input.reviewOverrideReason?.trim() || null,
          accountIds: input.accounts.map((account) => account.accountId),
          clipCount: input.clips.length,
        },
        create: () => ({
          id: dependencies.createId(),
          workspaceId: input.workspaceId,
          projectId: input.projectId,
          idempotencyKey: input.idempotencyKey,
          requestFingerprint,
          status: "running",
          items: plans.map((plan) => ({
            id: dependencies.createId(),
            requestKey: plan.requestKey,
            clipId: plan.clip.clipId,
            expectedEditorRevision: plan.clip.expectedEditorRevision,
            accountId: plan.account.accountId,
            platform: plan.account.platform,
            scheduledFor: plan.scheduledFor,
            status: "pending",
            errorCode: null,
            retryable: false,
            socialPostId: null,
          })),
          createdAt: dependencies.now(),
          completedAt: null,
        }),
      });
      if (opened.operation.requestFingerprint !== requestFingerprint) {
        throw new BulkSocialSchedulingError("campaign_schedule_idempotency_conflict");
      }
      if (opened.replayed && opened.operation.status !== "running") {
        return publicOperation(opened.operation, true);
      }

      for (const plan of plans) {
        const claimed = await dependencies.store.claimItem(opened.operation.id, plan.requestKey);
        if (!claimed) continue;
        if (!plan.copy) {
          await dependencies.store.settleItem(opened.operation.id, plan.requestKey, claimed.claimToken, {
            status: "ineligible",
            errorCode: "assisted_copy_missing",
            retryable: false,
            socialPostId: null,
          });
          continue;
        }
        try {
          const scheduled = await dependencies.schedule({
            actorUserId: input.actorUserId,
            workspaceId: input.workspaceId,
            projectId: input.projectId,
            clientIdempotencyKey: bulkScheduleDeterministicUuid(
              `${input.workspaceId}:${input.projectId}:${plan.requestKey}`,
            ),
            clipId: plan.clip.clipId,
            expectedEditorRevision: plan.clip.expectedEditorRevision,
						clipExportId: plan.clip.exportId,
						clipExportVariantId: plan.clip.exportVariantId,
            accountId: plan.account.accountId,
            platform: plan.account.platform,
            caption: plan.copy.caption,
            hashtags: [...plan.copy.hashtags],
            title: plan.copy.title,
            providerSettings: plan.copy.providerSettings ?? {},
            assistedCopyVariantId: plan.copy.variantId,
            aspectRatio: plan.clip.aspectRatio,
            resolution: plan.clip.resolution,
            thumbnail: plan.thumbnail,
            scheduledFor: plan.scheduledFor,
						reviewOverrideReason: input.reviewOverrideReason,
          });
          await dependencies.store.settleItem(opened.operation.id, plan.requestKey, claimed.claimToken, {
            status: "succeeded",
            errorCode: null,
            retryable: false,
            socialPostId: scheduled.socialPostId,
          });
        } catch (error) {
          const normalized = error instanceof ExpectedDomainFailureError
            ? {
                code: error.code,
                retryable:
                  error.kind === "rate_limited" || error.kind === "unavailable",
              }
            : {
                code: "campaign_schedule_item_failed",
                retryable: false,
              };
          await dependencies.store.settleItem(opened.operation.id, plan.requestKey, claimed.claimToken, {
            status: normalized.retryable ? "failed" : "ineligible",
            errorCode: normalized.code,
            retryable: normalized.retryable,
            socialPostId: null,
          });
        }
      }
      const settled = await dependencies.store.settleOperation(
        opened.operation.id,
        dependencies.now(),
      );
      return publicOperation(settled, opened.replayed);
    },
  };
}

function cloneOperation(operation: BulkScheduleOperation): BulkScheduleOperation {
  return {
    ...operation,
    items: operation.items.map((item) => ({
      ...item,
      scheduledFor: item.scheduledFor ? new Date(item.scheduledFor) : null,
    })),
    createdAt: new Date(operation.createdAt),
    completedAt: operation.completedAt ? new Date(operation.completedAt) : null,
  };
}

export function createInMemoryBulkScheduleStore(): BulkScheduleStore {
  const operations = new Map<string, BulkScheduleOperation>();
	const claims = new Map<string, string>();
  return {
    async open(input) {
      const existing = [...operations.values()].find(
        (operation) => operation.workspaceId === input.workspaceId &&
          operation.projectId === input.projectId &&
          operation.idempotencyKey === input.idempotencyKey,
      );
      if (existing) return { operation: cloneOperation(existing), replayed: true };
      const created = input.create();
      operations.set(created.id, cloneOperation(created));
      return { operation: cloneOperation(created), replayed: false };
    },
    async claimItem(operationId, requestKey) {
      const operation = operations.get(operationId);
      const item = operation?.items.find((candidate) => candidate.requestKey === requestKey);
      if (!operation || !item || item.status !== "pending") return null;
      item.status = "processing";
			const claimToken = bulkScheduleDeterministicUuid(`${operationId}:${requestKey}:${item.id}`);
			claims.set(`${operationId}:${requestKey}`, claimToken);
      return { item: { ...item }, claimToken };
    },
    async settleItem(operationId, requestKey, claimToken, patch) {
      const operation = operations.get(operationId);
      const item = operation?.items.find((candidate) => candidate.requestKey === requestKey);
      if (!item) throw new BulkSocialSchedulingError("campaign_schedule_item_not_found");
			if (claims.get(`${operationId}:${requestKey}`) !== claimToken) {
				throw new BulkSocialSchedulingError("campaign_schedule_claim_lost");
			}
      Object.assign(item, patch);
			claims.delete(`${operationId}:${requestKey}`);
    },
    async settleOperation(operationId, now) {
      const operation = operations.get(operationId);
      if (!operation) throw new BulkSocialSchedulingError("campaign_schedule_not_found");
      const ineligible = operation.items.filter((item) => item.status === "ineligible").length;
      const failed = operation.items.filter((item) => item.status === "failed").length;
      const succeeded = operation.items.filter((item) => item.status === "succeeded").length;
      operation.status = succeeded === 0
        ? "failed"
        : ineligible + failed > 0
          ? "partial"
          : "completed";
      operation.completedAt = now;
      return cloneOperation(operation);
    },
  };
}
