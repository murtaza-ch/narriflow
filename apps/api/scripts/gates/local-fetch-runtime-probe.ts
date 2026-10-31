import type {LocalFetchMailbox} from '../../src/durable-objects/local-fetch-mailbox';
export {LocalFetchMailbox} from '../../src/durable-objects/local-fetch-mailbox';
export default {async fetch(request:Request,env:{LOCAL_FETCH_MAILBOX:DurableObjectNamespace<LocalFetchMailbox>}){
 const url=new URL(request.url),workspaceId=url.pathname.split('/')[url.pathname.endsWith('/socket')?3:2]!;const stub=env.LOCAL_FETCH_MAILBOX.getByName(workspaceId);
 if(url.pathname.endsWith('/socket'))return stub.fetch(request);
 const body=request.method==='POST'?await request.json() as any:{};
 try{
 if(url.pathname.endsWith('/register')){await stub.register(body);return Response.json({ok:true});}
 if(url.pathname.endsWith('/ticket'))return Response.json(await stub.connectTicket(body.sessionId));
 if(url.pathname.endsWith('/presence'))return Response.json(await stub.presence());
 if(url.pathname.endsWith('/authorize'))return Response.json(await stub.authorize(body.sessionId));
 if(url.pathname.endsWith('/deliver'))return Response.json(await stub.deliver(body));
 if(url.pathname.endsWith('/revoke')){await stub.revoke(body);return Response.json({ok:true});}
 return new Response(null,{status:404});
 }catch{return Response.json({error:'device_refused'},{status:409});}
}};
