import type { InferRequestType, InferResponseType } from "hono/client";
import type { RestClient } from "./index";

type Assert<T extends true> = T;
type NotAny<T> = 0 extends (1 & T) ? false : true;
type Workspace = InferResponseType<RestClient["workspace"]["$get"], 200>;
type Submit = InferRequestType<RestClient["projects"]["$post"]>;
type Accepted = InferResponseType<RestClient["projects"]["$post"], 202>;
export type RestInferenceChecks = [
  Assert<NotAny<Workspace>>,
  Assert<Workspace extends { workspace: { workspaceId: string } } ? true : false>,
  Assert<Submit extends { json: { url: string }; header: { "idempotency-key": string } } ? true : false>,
  Assert<Accepted extends { operation: { statusUrl: string }; reviewUrl: string } ? true : false>,
];
