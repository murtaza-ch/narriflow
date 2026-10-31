const id="[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}";
const namespace=new RegExp(`^(?:execution-input/.+|execution-inputs/[1-9][0-9]*/(?:generated|publication)/${id}/[1-9][0-9]*/${id}\\.json|projects/${id}/(?:preparations|render-groups|export-bundles)/${id}/${id}\\.json)$`);
/** The same server-planned private input namespaces enter the conditional
 * writer and the read signer. No caller-controlled generic R2 key is admitted. */
export function isExecutionInputKey(value:unknown):value is string{
 return typeof value==="string"&&/^[A-Za-z0-9][A-Za-z0-9/_.-]{0,1023}$/.test(value)&&!value.split("/").some(part=>part===""||part==="."||part==="..")&&namespace.test(value);
}
