import {expect,test} from "bun:test";
import {batchedAcceptanceConfig,batchedRestoreProof,batchedDeadline,batchedTimings} from "./executor-r2-batched-acceptance";
const config={version:1,expectedEpoch:10,expectedWorkerVersion:"new-verified-version",apiOrigin:"https://candidate.narriflow.test",qualifiedRestoreProofPath:"/private/actual-restore-verified.json",expectedFunctionId:"fu-12345678901234567890",modalSourceWitness:"35ca"};
test("the coalesced gate requires epoch10 and a passed fresh8/9/10 qualified restore",()=>{
 expect(batchedAcceptanceConfig(config)).toEqual(config);
 for(const change of [{expectedEpoch:2},{expectedEpoch:3},{expectedEpoch:5},{expectedEpoch:7},{expectedEpoch:8},{expectedEpoch:9},{expectedEpoch:null},{expectedWorkerVersion:""},{expectedFunctionId:"latest"},{modalSourceWitness:"old-005f"},{qualifiedRestoreProofPath:"relative.json"}])expect(()=>batchedAcceptanceConfig({...config,...change})).toThrow();
 const proof={mode:"qualified_restore_verified",sourceEpoch:8,snapshotEpoch:9,targetEpoch:10,chargedStarts:2,staleCommit:"superseded",publishedAssets:1,operationDeadlineAt:"2026-11-01T22:10:00.000Z",completedAt:"2026-11-01T22:09:00.000Z"};
 expect(()=>batchedRestoreProof(proof)).not.toThrow();
 for(const change of [{sourceEpoch:3,snapshotEpoch:4,targetEpoch:5},{sourceEpoch:5,snapshotEpoch:6,targetEpoch:7},{sourceEpoch:6,snapshotEpoch:7,targetEpoch:8},{targetEpoch:9},{chargedStarts:1},{staleCommit:"committed"},{mode:"pending"},{operationDeadlineAt:"invalid"},{completedAt:"2026-11-01T22:11:00.000Z"}])expect(()=>batchedRestoreProof({...proof,...change})).toThrow();
});
test("both phases keep one nominal SQL deadline rather than confusing a conservative local cutoff with a new budget",()=>{
 expect(batchedDeadline(2700000)).toBe(2700000);
 expect(batchedDeadline(2700000,2700000)).toBe(2700000);
 expect(()=>batchedDeadline(2700000,2600000)).toThrow();
 expect(()=>batchedDeadline(2700000,5400000)).toThrow();
 expect(()=>batchedDeadline(Number.NaN)).toThrow();
});
test("only fixed numeric timing summaries leave the private native report",()=>{
 const timing={calls:4,failures:0,sumSeconds:9,maxSeconds:3,meanSeconds:2.25,maxConcurrentCalls:4,unfinishedCalls:0,histogramCounts:[1,2,1],histogramUpperSeconds:[1,2,null]};
 expect(batchedTimings({authorize_part:timing})).toEqual({authorize_part:{calls:4,failures:0,sumSeconds:9,maxSeconds:3,meanSeconds:2.25,maxConcurrentCalls:4,unfinishedCalls:0}});
 for(const raw of [{private_url:timing},{authorize_part:{...timing,meanSeconds:"https://secret.invalid"}},{authorize_part:{...timing,unfinishedCalls:1}},{authorize_part:{...timing,sumSeconds:Number.NaN}}])expect(()=>batchedTimings(raw)).toThrow();
});
