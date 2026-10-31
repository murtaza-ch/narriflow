import { getPrismaClient } from "@narriflow/db/client";
export async function purgeExpiredGeneratedMediaPrompts(now=new Date()){
 const database=getPrismaClient();if(!database)throw new Error("Database scope required");
 return database.generatedMediaJob.updateMany({where:{status:{in:["completed","failed","rejected","cancelled"]},promptExpiresAt:{lte:now},protectedPrompt:{not:""}},data:{protectedPrompt:""}});
}
