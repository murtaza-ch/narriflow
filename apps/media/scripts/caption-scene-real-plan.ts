/**
 * The production planning step of a real clip, shared by `caption-scene-real-render.ts` and
 * `caption-scene-real-check.ts`: inspectMedia -> stored automatic-layout evidence -> planClipComposition, with only
 * `captionPreset` swapped per preset (`applyCaptionPresetLook`, as the Studio does; `current` keeps the document's own).
 * Holds no data.
 */
import { automaticLayoutInputFingerprint, planClipComposition, type ClipCompositionPlanInput } from "@narriflow/composition-plan";
import {
  CLIP_AUTO_LAYOUT_ENGINE,
  SCREEN_LAYOUT_ENGINE_VERSION,
  applyCaptionPresetLook,
  buildClipCutPlan,
  clipAspectRatioOptions,
  clipAutoLayoutAnalysisSchema,
  editorDocumentSchema,
  getCaptionPresetById,
} from "@narriflow/validators";
import { compositionSourceFor, deriveRenderCompositionAssets, deriveRenderCompositionEvidence } from "../src/tasks/clip-render-attempt";
import { productionWorkerProcessModule, withAudioTimestampGaps } from "../src/worker-process";

export type RealDocument = ReturnType<typeof editorDocumentSchema.parse>;

export async function createRealPlanner(input: {
  document: unknown;
  evidence: { automatic?: unknown } | null;
  sourcePath: string;
  aspectRatio?: string;
  signal?: AbortSignal;
}) {
  const signal = input.signal ?? new AbortController().signal;
  const baseDocument = editorDocumentSchema.parse(structuredClone(input.document));
  const aspect = clipAspectRatioOptions.find((candidate) => candidate.value === (input.aspectRatio ?? "9:16"));
  if (!aspect) throw new Error(`unknown aspect ratio ${input.aspectRatio}`);
  const probed = await productionWorkerProcessModule.inspectMedia({ sourcePath: input.sourcePath, signal, deadlineMs: 120_000 });
  const inspection = await withAudioTimestampGaps(productionWorkerProcessModule, probed, { sourcePath: input.sourcePath, startSec: baseDocument.clipStartSec, endSec: baseDocument.clipEndSec, signal, deadlineMs: 120_000 });
  const cutPlan = buildClipCutPlan(baseDocument.deletedRanges, { startSec: baseDocument.clipStartSec, endSec: baseDocument.clipEndSec });

  // The stored automatic-layout analysis, as the render attempt hands it to the planner (it keeps its own source identity).
  const stored = input.evidence?.automatic ? clipAutoLayoutAnalysisSchema.safeParse(input.evidence.automatic) : null;
  const sourceIdentity = stored?.success ? stored.data.sourceIdentity : "real:source";
  const plannerSource = compositionSourceFor(inspection, sourceIdentity);
  const evidence: ClipCompositionPlanInput["evidence"] = deriveRenderCompositionEvidence({
    unavailableAutomaticState: "missing",
    availability: {
      automaticLayout: stored?.success
        ? { state: "available", value: { sourceIdentity, inputFingerprint: automaticLayoutInputFingerprint({ sourceIdentity, clipStartSec: baseDocument.clipStartSec, clipEndSec: baseDocument.clipEndSec, deletedRanges: baseDocument.deletedRanges, engineVersion: CLIP_AUTO_LAYOUT_ENGINE }), engineVersion: CLIP_AUTO_LAYOUT_ENGINE, analysis: stored.data } }
        : { state: "missing" },
      splitLayout: { state: "missing" },
      screenLayout: { state: "missing" },
    } as never,
    sourceIdentity,
    clipStartSec: baseDocument.clipStartSec,
    clipEndSec: baseDocument.clipEndSec,
    deletedRanges: baseDocument.deletedRanges,
  });
  if (input.evidence?.automatic && !stored?.success) console.warn(`stored automatic layout evidence does not parse (${stored?.error.issues[0]?.message}); planning without it`);

  function documentFor(preset: string): RealDocument {
    const named = preset === "current" ? null : getCaptionPresetById(preset);
    if (preset !== "current" && !named) throw new Error(`unknown preset ${preset}`);
    return editorDocumentSchema.parse({ ...baseDocument, captionPreset: named ? applyCaptionPresetLook(baseDocument.captionPreset, named) : baseDocument.captionPreset });
  }

  function planDocument(document: RealDocument) {
    const result = planClipComposition({
      document,
      source: plannerSource,
      evidence,
      assets: deriveRenderCompositionAssets({
        document, resolvedSceneAssets: {}, sceneVisualAvailability: {}, sceneFontAvailability: {},
        backgroundImage: { state: "missing" } as never, brollPlan: null, userBrollUrl: document.brollUrl,
        brandLogo: null, brandLogoWasRequested: false, plannedLogoSettings: null, musicPlans: [], sfxPlans: [],
      }),
      capabilities: { automaticSpeakerLayout: true, automaticSpeakerEngineVersion: CLIP_AUTO_LAYOUT_ENGINE, explicitSplitLayout: true, splitEngineVersion: "explicit-split-v1", screenLayout: true, screenEngineVersion: SCREEN_LAYOUT_ENGINE_VERSION },
      targets: [{ id: "vertical", aspectRatio: aspect!.value, width: aspect!.width, height: aspect!.height, outputTreatment: { resolution: "1080p", watermark: false } } as never],
    });
    if (result.status === "invalid") throw new Error(`Clip Composition Plan rejected ${result.error.code}`);
    return result.plan;
  }

  return { baseDocument, inspection, cutPlan, documentFor, planDocument, planPreset: (preset: string) => planDocument(documentFor(preset)) };
}
