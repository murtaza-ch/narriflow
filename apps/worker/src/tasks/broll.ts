import { searchPexelsVideos } from "@narriflow/services";
import { resolveBrollCutaways as resolveCutaways, type ResolveBrollCutawaysParams } from "../../../media/src/tasks/broll";
export * from "../../../media/src/tasks/broll";
export { searchPexelsVideos } from "@narriflow/services";
export function resolveBrollCutaways(params: ResolveBrollCutawaysParams) {
 return resolveCutaways(params, searchPexelsVideos);
}
