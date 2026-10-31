import { planTranscript, type CaptionedVideoSettings } from "@narriflow/validators";
import { ingestAcquisitionSchema, type IngestAcquisition } from "@narriflow/validators/execution";

/** Captions remain on the Content Pack; intake freezes only its acquisition choice. */
export function freezeIngestAcquisition(pack?: {id:string;draft:boolean;captionedVideo:CaptionedVideoSettings|null}):IngestAcquisition {
  return ingestAcquisitionSchema.parse({audioPolicy:!pack||pack.draft?"pending_pack":
    planTranscript({captionedVideo:pack.captionedVideo??undefined,sourceProbe:null}).kind==="speech_to_text"?"required":"none",
    ...(pack?{contentPackId:pack.id}:{})});
}
