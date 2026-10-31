import { expect,test } from "bun:test";
import { buildCaptionedVideoSettings } from "@narriflow/validators";
import { freezeIngestAcquisition } from "./ingest-acquisition";

test("source admission freezes only the committed caption choice and never caption text",()=>{
  const id="60000000-0000-4000-8000-000000000001";
  expect(freezeIngestAcquisition()).toEqual({audioPolicy:"pending_pack"});
  const supplied=buildCaptionedVideoSettings({captions:{source:"supplied",text:"1\n00:00:00,000 --> 00:00:01,000\nPrivate source caption\n"}});
  expect(freezeIngestAcquisition({id,draft:true,captionedVideo:supplied})).toEqual({audioPolicy:"pending_pack",contentPackId:id});
  expect(freezeIngestAcquisition({id,draft:false,captionedVideo:supplied})).toEqual({audioPolicy:"none",contentPackId:id});
  expect(freezeIngestAcquisition({id,draft:false,captionedVideo:buildCaptionedVideoSettings({captions:{source:"none"}})})).toEqual({audioPolicy:"none",contentPackId:id});
  expect(freezeIngestAcquisition({id,draft:false,captionedVideo:null})).toEqual({audioPolicy:"required",contentPackId:id});
});
