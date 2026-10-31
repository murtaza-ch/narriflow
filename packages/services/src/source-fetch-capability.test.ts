import {describe,expect,test} from 'bun:test';
import {withServiceEnvironment} from './runtime-environment';
import {requireYouTubeImport,withLocalFetchPresence,youtubeImportCapability} from './source-fetch-capability';
const workspace=crypto.randomUUID();
const local={APP_ENV:'development',YOUTUBE_FETCH_MODE:'local',LOCAL_FETCH_WORKSPACE_IDS_JSON:JSON.stringify([workspace])};
describe('YouTube admission capability',()=>{
 test('offline and forbidden local devices cannot admit a new source',async()=>{
  await withServiceEnvironment(local,async()=>{expect((await youtubeImportCapability(workspace)).available).toBe(false);await expect(requireYouTubeImport(workspace)).rejects.toMatchObject({code:'local_fetch_offline'});});
  let calls=0;
  await withServiceEnvironment({...local,APP_ENV:'production'},()=>withLocalFetchPresence(async()=>{calls++;return {available:true};},async()=>{await expect(requireYouTubeImport(workspace)).rejects.toMatchObject({code:'youtube_unavailable'});}));
  expect(calls).toBe(0);
 });
 test('presence is checked only in the allowlisted device mailbox',async()=>{
  let calls=0;
  await withServiceEnvironment(local,()=>withLocalFetchPresence(async id=>{expect(id).toBe(workspace);calls++;return {available:true};},async()=>{await requireYouTubeImport(workspace);await expect(requireYouTubeImport(crypto.randomUUID())).rejects.toMatchObject({code:'youtube_unavailable'});}));expect(calls).toBe(1);
 });
 test('a proxy flag without a recorded acceptance check leaves upload as the available path',async()=>{
  await withServiceEnvironment({YOUTUBE_FETCH_MODE:'proxy'},async()=>expect((await youtubeImportCapability(workspace)).available).toBe(false));
  await withServiceEnvironment({YOUTUBE_FETCH_MODE:'proxy',YOUTUBE_PROXY_ACCEPTED:'true'},async()=>expect((await youtubeImportCapability(workspace)).available).toBe(true));
 });
});
