export type ExpectedDomainFailureKind =
  | "invalid"
  | "unprocessable"
  | "forbidden"
  | "payment_required"
  | "missing"
  | "conflict"
  | "rate_limited"
  | "unavailable";

export type ExpectedDomainFailureDetail =
  | string
  | number
  | boolean
  | null
  | ExpectedDomainFailureDetail[]
  | { [key: string]: ExpectedDomainFailureDetail };

export type ExpectedDomainFailureDetails = Record<
  string,
  ExpectedDomainFailureDetail
>;

const MAX_DETAIL_DEPTH = 4;
const MAX_DETAIL_MEMBERS = 16;
const MAX_DETAIL_STRING_LENGTH = 240;
const MAX_RETRY_AFTER_SECONDS = 86_400;

function boundedDetail(
  value: unknown,
  depth: number,
): ExpectedDomainFailureDetail | undefined {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") {
    return value.slice(0, MAX_DETAIL_STRING_LENGTH);
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (depth >= MAX_DETAIL_DEPTH) return undefined;
  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_DETAIL_MEMBERS)
      .flatMap((item) => {
        const bounded = boundedDetail(item, depth + 1);
        return bounded === undefined ? [] : [bounded];
      });
  }
  if (!value || typeof value !== "object") return undefined;
  const bounded: ExpectedDomainFailureDetails = {};
  for (const [key, item] of Object.entries(value).slice(
    0,
    MAX_DETAIL_MEMBERS,
  )) {
    const boundedItem = boundedDetail(item, depth + 1);
    if (boundedItem !== undefined) bounded[key] = boundedItem;
  }
  return bounded;
}

export function boundedExpectedDomainFailureDetails(
  details: unknown,
): ExpectedDomainFailureDetails | undefined {
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  return boundedDetail(details, 0) as ExpectedDomainFailureDetails;
}

export interface ExpectedDomainFailure<
  TCode extends string = string,
  TDetails extends object = ExpectedDomainFailureDetails,
> extends Error {
  readonly code: TCode;
  readonly kind: ExpectedDomainFailureKind;
  readonly details?: TDetails;
  readonly retryAfterSeconds?: number;
}

export class ExpectedDomainFailureError<
  TCode extends string = string,
  TDetails extends object = ExpectedDomainFailureDetails,
> extends Error implements ExpectedDomainFailure<TCode, TDetails> {
  readonly code: TCode;
  readonly kind: ExpectedDomainFailureKind;
  readonly details?: TDetails;
  readonly retryAfterSeconds?: number;

  constructor(input: {
    code: TCode;
    kind: ExpectedDomainFailureKind;
    message: string;
    details?: TDetails;
    retryAfterSeconds?: number;
  }) {
    super(input.message);
    this.name = "ExpectedDomainFailure";
    this.code = input.code;
    this.kind = input.kind;
    this.details = boundedExpectedDomainFailureDetails(input.details) as
      | TDetails
      | undefined;
    this.retryAfterSeconds = input.retryAfterSeconds
      ? Math.min(
          MAX_RETRY_AFTER_SECONDS,
          Math.max(1, Math.ceil(input.retryAfterSeconds)),
        )
      : undefined;
  }
}

export function isExpectedDomainFailure(
  error: unknown,
): error is ExpectedDomainFailure {
  return error instanceof ExpectedDomainFailureError;
}

export type ExpectedDomainFailureCatalog<TCode extends string> = Readonly<
  Record<TCode, ExpectedDomainFailureKind>
>;
