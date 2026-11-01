import {describe,expect,test} from "bun:test";
import {sourceReceipt,validateGateTarget,transferGateBudget} from "./executor-r2-transfer-gate";

describe("regional Executor transfer gate guards",()=>{
 test("only the explicitly selected private candidate database is accepted",()=>{
  const host="ep-private-fixture.c-7.us-east-2.aws.neon.tech";
  expect(validateGateTarget(`postgresql://fixture@${host}/serverless_pipeline_gates`,host,"serverless_pipeline_gates").hostname).toBe(host);
  expect(()=>validateGateTarget(`postgresql://fixture@${host}/neondb`,host,"neondb")).toThrow("gate_private_database_required");
  const shared="ep-rough-hill-b57kvyah.c-7.us-east-2.aws.neon.tech";
  expect(()=>validateGateTarget(`postgresql://fixture@${shared}/serverless_pipeline_gates`,shared,"serverless_pipeline_gates")).toThrow("gate_private_database_required");
  expect(()=>validateGateTarget(`postgresql://fixture@${host}/serverless_pipeline_gates`,"different.aws.neon.tech","serverless_pipeline_gates")).toThrow("gate_private_database_required");
 });
 test("native arguments retain the original SQL budget and contain no fresh phase lifetime",()=>{
  const deadline=new Date("2026-11-01T00:03:04.026Z");
  expect(transferGateBudget(deadline)).toEqual({startedAtUnixMs:deadline.getTime()-2700000,combinedDeadlineUnixMs:deadline.getTime()});
  expect(()=>transferGateBudget(new Date(Number.NaN))).toThrow("gate_budget_invalid");
 });
 test("a pin receipt must prove the known ten-GiB upload, closed MPU and revoked owner within the combined deadline",()=>{
  const token="00f63941-0d85-42c0-ac38-9654c8a3ba02",journal={upload:{invocation:{attemptToken:token}}} as never;
  const report={version:1,phase:"upload",status:"passed",artifactId:"97f10b25-efce-4784-906c-a033448c8680",runId:token,
   object:{key:"execution/1/fixture/owner/artifact",etag:'"source"',byteLength:10737418240,sha256:"a".repeat(64)},
   startedAtUnixMs:1000,combinedDeadlineUnixMs:2701000,combinedElapsedSeconds:100,stalePartStatus:404,revokedGrantStatus:409};
  expect(sourceReceipt(report as never,journal).object.byteLength).toBe(10737418240);
  for(const change of [{status:"failed"},{runId:crypto.randomUUID()},{combinedDeadlineUnixMs:2701001},
   {object:{...report.object,byteLength:5368709120}},{stalePartStatus:200},{revokedGrantStatus:200}]){
   expect(()=>sourceReceipt({...report,...change} as never,journal)).toThrow("gate_upload_report_invalid");
  }
 });
});
