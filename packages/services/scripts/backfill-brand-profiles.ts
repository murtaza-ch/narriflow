import { brandProfileService } from "../src/brand-profile.service";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

const observe = process.argv.includes("--observe");
const batchSize = Number(argument("--batch-size") ?? 100);
const maximumBatches = Number(argument("--max-batches") ?? 1000);
let cursor = argument("--cursor");
let batches = 0;
let processedTemplates = 0;
let attachedTemplates = 0;
let createdProfiles = 0;

while (batches < maximumBatches) {
  const result = await brandProfileService.backfillCompatibilityProfiles({
    cursor,
    batchSize,
    observe,
  });
  batches += 1;
  processedTemplates += result.processedTemplates;
  attachedTemplates += result.attachedTemplates;
  createdProfiles += result.createdProfiles;
  cursor = result.nextCursor ?? undefined;
  console.warn(JSON.stringify({
    level: "info",
    message: "brand_profile_backfill_batch",
    observe,
    batch: batches,
    processedTemplates: result.processedTemplates,
    attachedTemplates: result.attachedTemplates,
    createdProfiles: result.createdProfiles,
    nextCursor: result.nextCursor,
    done: result.done,
  }));
  if (result.done) break;
}

console.warn(JSON.stringify({
  level: "info",
  message: "brand_profile_backfill_complete",
  observe,
  batches,
  processedTemplates,
  attachedTemplates,
  createdProfiles,
  nextCursor: cursor ?? null,
}));
