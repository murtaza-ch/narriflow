import { planGeneratedValidationSource } from "./generated-media-validation";
import { readServiceEnvironment, type ServiceEnvironment } from "./runtime-environment";
import { getPrismaClient } from "@narriflow/db/client";
import { generatedValidationPlanSchema } from "@narriflow/validators/native-validation";
import { createGeneratedMediaPublisher, GeneratedMediaPublicationError } from "./generated-media-publisher";
import { getNativeValidationService } from "./native-validation-runtime";
import { headObject, putObjectBytes } from "./r2-storage";

/** The planned source commits before upload; no asset is created here. */
export function createProductionGeneratedMediaPublisher(environment:ServiceEnvironment=readServiceEnvironment()) {
 const configured=Number(environment.GENERATED_IMAGE_MAX_OUTPUT_BYTES);
 const maxBytes=Number.isSafeInteger(configured)&&configured>=1000000&&configured<=100000000?configured:20*1024*1024;
 const database=getPrismaClient();
 if(!database)throw new GeneratedMediaPublicationError("generated_media_claim_lost");
 return createGeneratedMediaPublisher({maxBytes,
  current:async id=>{const row=await database.generatedMediaJob.findUnique({where:{id},select:{validationJobId:true,validationInput:true}});return row?{validationJobId:row.validationJobId,validationInput:row.validationInput===null?null:generatedValidationPlanSchema.parse(row.validationInput)}:null;},
  plan:(jobId,claimId,source)=>planGeneratedValidationSource(database,{jobId,claimId,source}),
  exists:async source=>{
   try{const object=await headObject(source.key);if(object.contentType!==source.contentType||object.sizeBytes!==source.sizeBytes||!object.etag)throw new GeneratedMediaPublicationError("generated_media_attempt_unavailable");return true;}
   catch(error){if((error as {$metadata?:{httpStatusCode?:number}}).$metadata?.httpStatusCode===404)return false;throw error;}
  },
  stage:async input=>{await putObjectBytes({...input,ifNoneMatch:"*",metadata:{source:"generated-media-validation"}});},
  admit:(scope,request)=>getNativeValidationService().admitGenerated(scope,request),
 });
}
