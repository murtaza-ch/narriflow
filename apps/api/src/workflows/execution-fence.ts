import type { ExecutionDispatchReference } from "@narriflow/validators/execution";
import { EXECUTION_RESTORE_PHASES } from "@narriflow/services/execution-restore";

const metadataPhases=new Set<string>(EXECUTION_RESTORE_PHASES.filter(phase=>!phase.startsWith("redispatch")));

/** Restore pages can transform authority while every product consumer stays
 * stopped. Provider-capable TS drivers are consumers too. */
export function canRunWhileFenced(reference: ExecutionDispatchReference): boolean {
  if(reference.kind!=="maintenance"||reference.subject.kind!=="maintenance"||reference.generation!==1)return false;
  const match=/^rs2\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})\.([1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,12})\.([a-z_]+)(?:\.(0|[1-9][0-9]{0,12})\.[a-f0-9]{32})?$/.exec(reference.subject.id);
  return Boolean(match&&Number(match[1])===Number(match[2])&&Number(match[3])===Number(match[1])+1&&Number(match[3])===reference.deploymentEpoch&&metadataPhases.has(match[5]!));
}
