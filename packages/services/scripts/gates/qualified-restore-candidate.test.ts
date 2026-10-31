import {expect,test} from "bun:test";
import {candidateRestoreJournal,candidateRestoreTarget,candidateRestoreRefusal,candidateRestorePostgresVersion,candidateRestoreUtilityTimeout,candidateRestoreOperatorSelection} from "./qualified-restore-candidate";
const connection="postgresql://operator:example@ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech/serverless_pipeline_gates?sslmode=verify-full";
const journal=()=>({version:1,runId:crypto.randomUUID(),jobId:crypto.randomUUID(),dispatchId:crypto.randomUUID(),attemptToken:crypto.randomUUID(),artifactId:crypto.randomUUID(),commandSha256:"a".repeat(64),operationDeadlineAt:"2026-11-01T01:10:00.000Z",fencedVersion:"fenced-version",snapshotPath:"/private/run/snapshot.dump",proofPath:"/private/run/proof.json",refusalPath:"/private/run/refusal.json"});
test("the archive process can exceed83seconds but preserves30seconds of the original native budget",()=>{
 const now=1000000;
 expect(candidateRestoreUtilityTimeout(now+600000,now)).toBe(180000);
 expect(candidateRestoreUtilityTimeout(now+150000,now)).toBe(120000);
 expect(candidateRestoreUtilityTimeout(now+114000,now)).toBe(84000);
 expect(candidateRestoreUtilityTimeout(now+31000,now)).toBe(1000);
 for(const deadline of [now+30999,now+30000,now-1,Number.NaN,Number.POSITIVE_INFINITY])expect(()=>candidateRestoreUtilityTimeout(deadline,now)).toThrow();
});
test("candidate archive utilities require pinned18.6 and the observed PostgreSQL18 server major",()=>{
 expect(candidateRestorePostgresVersion("pg_dump","pg_dump (PostgreSQL) 18.6\n",180006)).toEqual({utilityVersion:"18.6",serverMajor:18});
 expect(candidateRestorePostgresVersion("pg_restore","pg_restore (PostgreSQL) 18.6\n",180006)).toEqual({utilityVersion:"18.6",serverMajor:18});
 expect(candidateRestorePostgresVersion("pg_restore","pg_restore (PostgreSQL) 18.6 (Debian 18.6-1.pgdg12+2)\n",180006)).toEqual({utilityVersion:"18.6",serverMajor:18});
 for(const [tool,output,server] of [["pg_dump","pg_dump (PostgreSQL) 17.11",180006],["pg_restore","pg_restore (PostgreSQL) 17.11",180006],["pg_dump","pg_dump (PostgreSQL) 18.6",170011],["pg_restore","pg_restore (PostgreSQL) 18.6",190000],["pg_dump","pg_restore (PostgreSQL) 18.6",180006],["pg_dump","unrelated version 18.6",180006],["pg_dump","pg_dump (PostgreSQL) 18.5",180006]] as const)expect(()=>candidateRestorePostgresVersion(tool,output,server)).toThrow();
});
test("regional archive selection requires both exact Sandbox ID and private absolute journal path",()=>{
 expect(candidateRestoreOperatorSelection(undefined,undefined)).toBeNull();
 expect(candidateRestoreOperatorSelection("sb-01M69XYH8X4D1RJR2RZAA42M8N","/private/operator.json")).toEqual({sandboxId:"sb-01M69XYH8X4D1RJR2RZAA42M8N",journalPath:"/private/operator.json"});
 for(const [id,path] of [[undefined,"/private/operator.json"],["sb-01M69XYH8X4D1RJR2RZAA42M8N",undefined],["latest","/private/operator.json"],["sb-01M69XYH8X4D1RJR2RZAA42M8N","./operator.json"]])expect(()=>candidateRestoreOperatorSelection(id,path)).toThrow();
});
test("candidate snapshot tooling refuses another database, pooled/shared host or TLS downgrade before any connection",()=>{
 expect(candidateRestoreTarget(`${connection}&schema=public`).hostname).toBe("ep-wispy-field-b5wyn9o3.c-7.us-east-2.aws.neon.tech");
 for(const value of [connection.replace("serverless_pipeline_gates","neondb"),connection.replace("ep-wispy-field-b5wyn9o3","ep-rough-hill-b57kvyah"),connection.replace(".c-7.","-pooler.c-7."),connection.replace("verify-full","require"),`${connection}&schema=another`,`${connection}&options=-csearch_path%3Dpublic`])expect(()=>candidateRestoreTarget(value)).toThrow();
});
test("the operator journal freezes exact IDs and distinct absolute files without accepting credential or deadline override fields",()=>{
 const j=journal();
 expect(candidateRestoreJournal(j)).toEqual(j);
 for(const value of [{...j,snapshotPath:"./snapshot"},{...j,proofPath:j.snapshotPath},{...j,attemptToken:"latest"},{...j,key:"secret"},{...j,operationDeadlineAt:"invalid"}])expect(()=>candidateRestoreJournal(value)).toThrow();
});
test("the qualified gate accepts only the new source3 to restored5 refusal and rejects the obsolete epoch2 sequence",()=>{
 const j=candidateRestoreJournal(journal());
 const report={event:"restore_fault_refused",runId:j.runId,sourceEpoch:3,targetEpoch:5,dispatchId:j.dispatchId,attemptToken:j.attemptToken,artifactId:j.artifactId,commandSha256:j.commandSha256,refusal:"superseded"};
 expect(candidateRestoreRefusal(report,j)).toEqual(report);
 for(const epochs of [{sourceEpoch:2,targetEpoch:4},{sourceEpoch:3,targetEpoch:4},{sourceEpoch:4,targetEpoch:5},{sourceEpoch:4,targetEpoch:6}])expect(()=>candidateRestoreRefusal({...report,...epochs},j)).toThrow();
 expect(()=>candidateRestoreRefusal({...report,artifactId:crypto.randomUUID()},j)).toThrow();
});
