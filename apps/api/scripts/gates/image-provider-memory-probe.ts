import { createOpenAiImageProvider } from "../../../media/src/openai-image-provider";

(globalThis as unknown as {__imageProviderMemoryProbe:string}).__imageProviderMemoryProbe="narriflow-image-provider-memory-probe";
let retained: Uint8Array | null = null;
export default {
 async fetch(_request:Request,env:{FIXTURE_URL:string;TEST_BYTES:string}){
  if(new URL(_request.url).pathname==="/__warmup")return Response.json({probe:"narriflow-image-provider-memory-probe"});
  const size=Number(env.TEST_BYTES);
  if(!Number.isSafeInteger(size)||size<1000000||size>100000000||!env.FIXTURE_URL.startsWith("http://127.0.0.1:"))return new Response(null,{status:400});
  let calls=0;
  const provider=createOpenAiImageProvider({apiKey:"synthetic-memory-fixture",model:"synthetic-memory-fixture",maxOutputBytes:size,
   fetch:async(url,init)=>{if(String(url)!=="https://api.openai.com/v1/images/generations"||init?.redirect!=="error")throw new Error("unexpected_provider_endpoint");calls++;return fetch(env.FIXTURE_URL,{signal:init.signal});},
  });
  try{
   const result=await provider.submit({requestId:"synthetic-memory-fixture",prompt:"synthetic memory probe",aspectRatio:"1:1",style:"editorial"});
   if(result.kind!=="completed"||!result.result?.bytes)throw new Error("missing_synthetic_bytes");
   retained=result.result.bytes;
   await new Promise(resolve=>setTimeout(resolve,250));
   return Response.json({bytes:retained.length,first:retained[0],last:retained[retained.length-1],calls});
  }catch(error){return Response.json({code:(error as {code?:string}).code??"worker_error",message:error instanceof Error?error.message:"worker_error",calls},{status:500});}
 },
};
