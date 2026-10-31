import {expect,test} from "bun:test";
import {publicationNativeCommandSchema,publicationNativeReplySchema} from "./publication-execution";
test("publication control is finite, bounded and replies contain no credentials or scoped URLs",()=>{
 expect(publicationNativeCommandSchema.parse({kind:"provider_call",operation:"read"})).toEqual({kind:"provider_call",operation:"read"});
 expect(publicationNativeCommandSchema.safeParse({kind:"provider_call",operation:"anything",accessToken:"secret"}).success).toBe(false);
 expect(publicationNativeCommandSchema.safeParse({kind:"checkpoint",operation:{kind:"upload",state:{large:"a".repeat(64*1024)}}}).success).toBe(false);
 for(const field of ["accessToken","signedUrl","url","media","checkpoint"])
  expect(publicationNativeReplySchema.safeParse({kind:"recorded",[field]:"private"}).success).toBe(false);
});
