export const CAMPAIGN_SELECTION_STORAGE_KEY =
  "narriflow:campaign-clip-selection:v1";

export interface CampaignSelectionStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

type StoredCampaignSelection = {
  version: 1;
  projectId: string;
  clipIds: string[];
};

function normalizeClipIds(clipIds: Iterable<string>): string[] {
  return [...new Set(clipIds)]
    .filter((clipId) => typeof clipId === "string" && clipId.length > 0)
    .sort()
    .slice(0, 100);
}

function readStoredSelection(
  storage: CampaignSelectionStorage,
): StoredCampaignSelection | null {
  try {
    const raw = storage.getItem(CAMPAIGN_SELECTION_STORAGE_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<StoredCampaignSelection>;
    if (
      value.version !== 1 ||
      typeof value.projectId !== "string" ||
      !Array.isArray(value.clipIds) ||
      value.clipIds.length > 100 ||
      value.clipIds.some((clipId) => typeof clipId !== "string")
    ) {
      storage.removeItem(CAMPAIGN_SELECTION_STORAGE_KEY);
      return null;
    }
    return {
      version: 1,
      projectId: value.projectId,
      clipIds: normalizeClipIds(value.clipIds),
    };
  } catch {
    storage.removeItem(CAMPAIGN_SELECTION_STORAGE_KEY);
    return null;
  }
}

export function persistCampaignSelection(
  storage: CampaignSelectionStorage,
  projectId: string,
  clipIds: Iterable<string>,
): void {
  const normalized = normalizeClipIds(clipIds);
  if (normalized.length === 0) {
    storage.removeItem(CAMPAIGN_SELECTION_STORAGE_KEY);
    return;
  }
  storage.setItem(
    CAMPAIGN_SELECTION_STORAGE_KEY,
    JSON.stringify({ version: 1, projectId, clipIds: normalized }),
  );
}

export function restoreCampaignSelection(
  storage: CampaignSelectionStorage,
  projectId: string,
  availableClipIds: Iterable<string>,
): Set<string> {
  const stored = readStoredSelection(storage);
  if (!stored) return new Set();
  if (stored.projectId !== projectId) {
    clearCampaignSelection(storage);
    return new Set();
  }

  const available = new Set(availableClipIds);
  const restored = stored.clipIds.filter((clipId) => available.has(clipId));
  persistCampaignSelection(storage, projectId, restored);
  return new Set(restored);
}

export function clearCampaignSelection(
  storage: CampaignSelectionStorage,
): void {
  storage.removeItem(CAMPAIGN_SELECTION_STORAGE_KEY);
}
