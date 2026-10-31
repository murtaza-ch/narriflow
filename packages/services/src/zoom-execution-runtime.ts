import { getPrismaClient } from "@narriflow/db/client";
import { ZoomNotificationExecution } from "./zoom-execution";
import { deliverExecutionDispatches } from "./execution-dispatch-runtime";
import { projectService } from "./project.service";
import { zoomService } from "./zoom.service";
import { ProcessingUsageError } from "./processing-usage";
import { BrandProfileMembershipError, BrandProfileMissingAssetError, BrandProfileNotFoundError } from "./brand-profile.service";
import { isBrandAccessRefusal } from "./brand-ownership";
export function getZoomNotificationExecution():ZoomNotificationExecution {
  const database=getPrismaClient();
  if(!database)throw Error("zoom_notification_database_unavailable");
  const driver:ZoomNotificationExecution=new ZoomNotificationExecution({database,register:deliverExecutionDispatches,
    revokeConnection:(id,before)=>zoomService.revokeNotifiedConnection(id,before),
    importRecording:async input=>{
      try{
        return await projectService.importZoomRecording(input.target.scope,{
          source:input.target.plan.source,connectionId:input.target.connectionId,
          notification:input.notification,titlePrefix:input.target.titlePrefix,recipe:input.target.plan.recipe,
          beforeAutopilotAdmit:tx=>driver.assertIntakeWithinTransaction(tx,input),confirmIngest:deliverExecutionDispatches,
        });
      }catch(error){
        if(input.target.plan.recipe.brandProfileId&&(error instanceof BrandProfileNotFoundError||error instanceof BrandProfileMissingAssetError||error instanceof BrandProfileMembershipError||isBrandAccessRefusal(error)))return {count:0,refusal:"brand_profile"};
        if(error instanceof ProcessingUsageError)return {count:0,refusal:error.code==="upload_too_long"?"too_long":"deferred"};
        throw error;
      }
    },
  });
  return driver;
}
