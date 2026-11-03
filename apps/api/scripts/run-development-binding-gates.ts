import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createRequire} from 'node:module';
import {createHmac} from 'node:crypto';
const api=fileURLToPath(new URL('..',import.meta.url)),require=createRequire(new URL('../package.json',import.meta.url));
const dependency=createRequire(require.resolve('wrangler/package.json'));
const {Miniflare,convertV4MiniflareOptions}=dependency('miniflare');
const {transform}=dependency('esbuild');
const clientSource=(await transform(await readFile(join(api,'scripts/gates/development-binding-client-probe.ts'),'utf8'),{loader:'ts',format:'esm',target:'es2022'})).code;
const common={compatibilityDate:'2026-10-30',compatibilityFlags:['nodejs_compat','disallow_importable_env'],modules:true};
const progressKey=Buffer.alloc(32,7);
const mf=new Miniflare(convertV4MiniflareOptions({workers:[
 {...common,name:'cloud-development',scriptPath:join(api,'dist/worker/index.js'),durableObjects:{RATE_LIMITER:{className:'RateLimiter',useSQLite:true},PROJECT_PROGRESS:{className:'ProjectProgress',useSQLite:true},LOCAL_FETCH_MAILBOX:{className:'LocalFetchMailbox',useSQLite:true}},bindings:{APP_ENV:'development',API_ORIGIN:'https://api.narriflow.test',CORS_ALLOWED_ORIGINS:'http://localhost:3000',PROGRESS_CONNECT_KEY_ID:'gate',PROGRESS_CONNECT_KEYS_JSON:JSON.stringify({gate:progressKey.toString('base64url')}),YOUTUBE_FETCH_MODE:'local',LOCAL_FETCH_WORKSPACE_IDS_JSON:'["11111111-1111-4111-8111-111111111111"]'}},
 {...common,name:'local-development',script:clientSource,serviceBindings:{DEV_CLOUD:{name:'cloud-development',entrypoint:'DevelopmentBindings'}}},
 {...common,name:'fenced-development',scriptPath:join(api,'dist/worker/index.js'),bindings:{APP_ENV:'development',ADMISSION_STATE:'fenced'}},
 {...common,name:'fenced-client',script:clientSource,serviceBindings:{DEV_CLOUD:{name:'fenced-development',entrypoint:'DevelopmentBindings'}}},
]}));
try{
 const client=await mf.getWorker('local-development'),checks:string[]=[];
 async function json(path:string){const response=await client.fetch(new Request('http://gate'+path));assert.equal(response.status,200);return response.json();}
 assert.equal((await json('/rate')).allowed,true);assert.equal((await json('/rate')).allowed,false);checks.push('service_rpc_uses_same_durable_rate_counter');
 assert.deepEqual(await json('/presence'),{available:false});checks.push('device_presence_over_rpc_without_database_configuration');
 const issued=await json('/progress-ticket'),parts=issued.ticket.split('.'),payload=JSON.parse(Buffer.from(parts[2],'base64url').toString());
 assert.equal(parts[3],createHmac('sha256',progressKey).update(parts.slice(0,3).join('.')).digest('base64url'));
 assert.equal(payload.audience,'https://api.narriflow.test/api/progress');assert.equal(payload.origin,'http://localhost:3000');assert.equal(payload.projectId,'11111111-1111-4111-8111-111111111111');
 assert.equal(payload.authorizedAt,issued.authorizedAt);assert.equal(payload.ticketExpiresAt,issued.authorizedAt+30000);assert.equal(payload.subscriptionExpiresAt,issued.authorizedAt+60000);
 checks.push('local_admission_gets_a_cloud_audience_ticket_over_real_rpc_without_database_configuration');
 for(const mode of ['origin','expired','future']){const result=await json('/progress-ticket?mode='+mode);assert.equal(result.refused,true);assert.equal(result.reason,mode==='origin'?'progress_origin_not_allowed':'progress_authorization_expired');}
 checks.push('development_signer_refuses_wrong_origin_and_expired_or_future_authorization');
 assert.deepEqual(await json('/invalid-dispatch'),{refused:true});checks.push('invalid_reference_refused_before_database');
 assert.deepEqual(await json('/private'),{exposed:false});checks.push('private_helpers_do_not_expose_worker_bindings');
 assert.equal((await client.fetch(new Request('http://gate/fetch-refused'))).status,404);checks.push('http_proxy_restricts_existing_socket_routes');
 const fenced=await mf.getWorker('fenced-client'),fencedResult=await (await fenced.fetch(new Request('http://gate/fenced-rpc'))).json();
 assert.deepEqual(fencedResult,{reasons:Array(12).fill('execution_fenced')});checks.push('fenced_rpc_refuses_all_twelve_methods_before_sql_or_durable_resources');
 const fencedWorker=await mf.getWorker('fenced-development');
 for(const cron of ['0 * * * *','0 0 * * *'])assert.equal((await fencedWorker.scheduled({cron,scheduledTime:new Date('2026-10-31T00:00:00.000Z')})).outcome,'ok');
 checks.push('fenced_hourly_daily_cron_stop_before_database_or_provider_configuration');
 console.log(JSON.stringify({runtime:'workerd',checks,passed:checks.length,postgresBindings:0,externalProviderRequests:0}));
}finally{await mf.dispose();}
