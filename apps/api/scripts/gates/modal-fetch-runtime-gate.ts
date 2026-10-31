import { createModalBridgeClient, ModalBridgeError } from "@narriflow/services/modal-bridge";

/** Actual public fetch through the production client. This deliberately
 * unknown key must reach the owned endpoint and be refused before any lookup,
 * spawn or database access. A runtime request-construction failure is a fail. */
export async function runModalFetchRuntimeGate() {
  const id="00000000-0000-4000-8000-000000000099";
  const client=createModalBridgeClient({origin:"https://murtazach275--narriflow-media-bridge.us-east.modal.run",keyId:"public-runtime-probe",key:new Uint8Array(32)});
  const started=Date.now();
  try {
    await client.command({action:"spawn",function:"asset_validation",attemptToken:id,reference:{dispatchId:id,kind:"modal_execution",subject:{kind:"native_validation",id},deploymentEpoch:1,generation:1,inputHash:"0".repeat(64)}},id);
  } catch(error) {
    if(error instanceof ModalBridgeError&&error.code==="modal_bridge_refused")return {passed:true,endpointRefusedUnknownKey:true,nativeWorkStarted:false,ms:Date.now()-started};
    throw Error(`modal_fetch_runtime_gate:${error instanceof ModalBridgeError?error.code:"unexpected_failure"}`);
  }
  throw Error("modal_fetch_runtime_gate:unknown_key_accepted");
}
