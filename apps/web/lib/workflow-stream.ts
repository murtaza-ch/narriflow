export function normalizeWorkflowSeq(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

export function isAfterWorkflowCursor(cursor: number, value: unknown): boolean {
  const sequence = normalizeWorkflowSeq(value);
  return sequence !== null && sequence > cursor;
}

export function advanceWorkflowCursor(cursor: number, value: unknown): number {
  const sequence = normalizeWorkflowSeq(value);
  return sequence !== null && sequence > cursor ? sequence : cursor;
}
