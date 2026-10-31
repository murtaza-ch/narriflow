import { getPrismaClient } from "@narriflow/db/client";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { readAssignedArtifactJson } from "./r2-storage";
import { OutboundProbeError, OutboundProbeService } from "./outbound-probe";

export function getOutboundProbeService() {
  const database = getPrismaClient();
  if (!database) throw new OutboundProbeError("outbound_probe_unavailable");
  return new OutboundProbeService(database, { register: deliverExecutionDispatches, readResult: readAssignedArtifactJson });
}
