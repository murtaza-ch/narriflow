import {expect,test} from "bun:test";
import {candidateRestoreJournal,candidateRestoreTarget} from "./qualified-restore-candidate";
const connection="postgresql://operator:example@ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech/serverless_pipeline_gates?sslmode=verify-full";
test("candidate snapshot tooling refuses another database, pooled/shared host or TLS downgrade before any connection",()=>{
 expect(candidateRestoreTarget(`${connection}&schema=public`).hostname).toBe("ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech");
 for(const value of [connection.replace("serverless_pipeline_gates","neondb"),connection.replace("ep-wispy-field-b5wyn9o3","ep-rough-hill-b57kvyah"),connection.replace(".c-7.","-pooler.c-7."),connection.replace("verify-full","require"),`${connection}&schema=another`,`${connection}&options=-csearch_path%3Dpublic`])expect(()=>candidateRestoreTarget(value)).toThrow();
});
test("the operator journal freezes exact IDs and distinct absolute files without accepting credential or deadline override fields",()=>{
 const journal={version:1,runId:crypto.randomUUID(),jobId:crypto.randomUUID(),dispatchId:crypto.randomUUID(),attemptToken:crypto.randomUUID(),artifactId:crypto.randomUUID(),commandSha256:"a".repeat(64),operationDeadlineAt:"2026-11-01T01:10:00.000Z",fencedVersion:"fenced-version",snapshotPath:"/private/run/snapshot.dump",proofPath:"/private/run/proof.json",refusalPath:"/private/run/refusal.json"};
 expect(candidateRestoreJournal(journal)).toEqual(journal);
 for(const value of [{...journal,snapshotPath:"./snapshot"},{...journal,proofPath:journal.snapshotPath},{...journal,attemptToken:"latest"},{...journal,key:"secret"},{...journal,operationDeadlineAt:"invalid"}])expect(()=>candidateRestoreJournal(value)).toThrow();
});
