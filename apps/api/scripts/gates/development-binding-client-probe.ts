import type {DevelopmentCloudPort} from '../../src/development-cloud-port';
export default {async fetch(request:Request,env:{DEV_CLOUD:DevelopmentCloudPort}){
 const path=new URL(request.url).pathname;
 if(path==='/rate')return Response.json(await env.DEV_CLOUD.checkRate('a'.repeat(64),{limit:1,windowSeconds:60,consume:true}));
 if(path==='/presence')return Response.json(await env.DEV_CLOUD.devicePresence('11111111-1111-4111-8111-111111111111'));
 if(path==='/invalid-dispatch'){try{await env.DEV_CLOUD.dispatch({} as never);return Response.json({refused:false});}catch{return Response.json({refused:true});}}
 if(path==='/private'){try{await (env.DEV_CLOUD as unknown as {bindings():Promise<unknown>}).bindings();return Response.json({exposed:true});}catch{return Response.json({exposed:false});}}
 if(path==='/fetch-refused')return env.DEV_CLOUD.fetch(new Request('https://api.narriflow.test/api/admin'));
 if(path==='/fenced-rpc'){
  const id='11111111-1111-4111-8111-111111111111',port=env.DEV_CLOUD;
  const calls=[
   ()=>port.dispatch({dispatchId:id,kind:'operation_driver',subject:{kind:'ingest_job',id},generation:1,deploymentEpoch:1,inputHash:'a'.repeat(64)}),
   ()=>port.progressContinuations([]),()=>port.publishProgress({projectId:id,workspaceId:id},{} as never),
   ()=>port.revokeProgress({projectId:id,workspaceId:id} as never),
   ()=>port.checkRate('a'.repeat(64),{limit:1,windowSeconds:60,consume:true}),
   ()=>port.registerDevice({} as never),()=>port.authorizeDevice(id,id),()=>port.connectDeviceTicket(id,id),
   ()=>port.devicePresence(id),()=>port.revokeDevice({workspaceId:id,authorizedBefore:0}),
   ()=>port.fetch(new Request('https://api.narriflow.test/api/admin')),
  ];
  const reasons:string[]=[];
  for(const call of calls){try{await call();reasons.push('accepted');}catch(error){reasons.push(error instanceof Error?error.message:String(error));}}
  return Response.json({reasons});
 }
 return new Response(null,{status:404});
}};
