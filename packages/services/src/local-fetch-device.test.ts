import {describe,expect,test} from 'bun:test';
import {createLocalFetchDeviceCodec,requireLocalFetchDevelopment} from './local-fetch-device';
const origin='https://narriflow-api-candidate.murtazach275.workers.dev';
const workspaceId=crypto.randomUUID(),actorUserId=crypto.randomUUID();
const codec=createLocalFetchDeviceCodec(new Map([['dev-v1',new Uint8Array(32).fill(9)]]));
describe('Development fetch device authority',()=>{
 test('session binds one workspace actor epoch and origin and derives a distinct scoped key',async()=>{
  const issued=await codec.issue({workspaceId,actorUserId,deploymentEpoch:1,apiOrigin:origin},'dev-v1',100000);
  const verified=await codec.verify(issued.token,100001);
  expect(verified.claims).toMatchObject({workspaceId,actorUserId,deploymentEpoch:1,apiOrigin:origin,issuedAt:100000,expiresAt:7300000});
  expect(verified.key).toEqual(issued.key);expect(verified.key).not.toEqual(new Uint8Array(32).fill(9));
  const another=await codec.issue({workspaceId,actorUserId,deploymentEpoch:1,apiOrigin:origin},'dev-v1',100000);
  expect(another.key).not.toEqual(issued.key);
  const tampered=issued.token.slice(0,-1)+(issued.token.endsWith('A')?'B':'A');
  await expect(codec.verify(tampered,100001)).rejects.toThrow('local_fetch_session_invalid');
  await expect(codec.verify(issued.token,7300000)).rejects.toThrow('local_fetch_session_invalid');
 });
 test('only the explicit development workspace allowlist can route locally',()=>{
  const good={APP_ENV:'development',YOUTUBE_FETCH_MODE:'local',LOCAL_FETCH_WORKSPACE_IDS_JSON:JSON.stringify([workspaceId])};
  expect(()=>requireLocalFetchDevelopment(good,workspaceId)).not.toThrow();
  for(const bad of [{...good,APP_ENV:'production'},{...good,YOUTUBE_FETCH_MODE:'proxy'},{...good,LOCAL_FETCH_WORKSPACE_IDS_JSON:'[]'}])expect(()=>requireLocalFetchDevelopment(bad,workspaceId)).toThrow('local_fetch_unavailable');
 });
});
