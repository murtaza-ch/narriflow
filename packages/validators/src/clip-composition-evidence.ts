type EvidenceVersion = {
  version: number;
  engine: string;
};

export class UnsupportedClipCompositionEvidenceVersion extends Error {
  readonly code = "unsupported_clip_composition_evidence_version";
  readonly retryable = false;

  constructor() {
    super("unsupported_clip_composition_evidence_version");
    this.name = "UnsupportedClipCompositionEvidenceVersion";
  }
}

/**
 * Stored composition evidence is executable planner input, not optional
 * presentation metadata. A value that declares a version must therefore be
 * either the exact contract understood by this deployment or fail closed.
 * Unversioned/malformed JSON remains a normal parse miss.
 */
export function assertSupportedClipCompositionEvidenceVersion(
  value: unknown,
  expected: EvidenceVersion,
  knownSiblingEngines: readonly string[] = [],
): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return;
  }
  const candidate = value as Record<string, unknown>;
  const hasVersion = Object.hasOwn(candidate, "version");
  const hasEngine = Object.hasOwn(candidate, "engine");
  const knownEngines = [expected.engine, ...knownSiblingEngines];
  if (
    (hasVersion && candidate.version !== expected.version) ||
    (hasEngine && !knownEngines.includes(String(candidate.engine)))
  ) {
    throw new UnsupportedClipCompositionEvidenceVersion();
  }
}
