import { describe, expect, test } from "bun:test";
import { uploadMimeTypeByExtension, uploadMimeTypeForFile, uploadMimeTypes } from "./upload";

describe("uploadMimeTypeForFile", () => {
  test("keeps a type the server accepts", () => {
    for (const type of uploadMimeTypes) expect(uploadMimeTypeForFile({ name: "source", type })).toBe(type);
  });

  test("names what a browser reports differently or not at all", () => {
    expect(uploadMimeTypeForFile({ name: "talk.m4v", type: "video/x-m4v" })).toBe("video/mp4");
    expect(uploadMimeTypeForFile({ name: "talk.M4A", type: "audio/x-m4a" })).toBe("audio/mp4");
    expect(uploadMimeTypeForFile({ name: "talk.mp3", type: "audio/mp3" })).toBe("audio/mpeg");
    expect(uploadMimeTypeForFile({ name: "talk.wav", type: "audio/vnd.wave" })).toBe("audio/wav");
    expect(uploadMimeTypeForFile({ name: "talk.mkv", type: "" })).toBe("video/x-matroska");
  });

  test("refuses what no upload can store", () => {
    expect(uploadMimeTypeForFile({ name: "talk.avi", type: "video/x-msvideo" })).toBeNull();
    expect(uploadMimeTypeForFile({ name: "notes.pdf", type: "application/pdf" })).toBeNull();
    expect(uploadMimeTypeForFile({ name: "noextension", type: "" })).toBeNull();
  });

  test("every extension maps to a type the server accepts", () => {
    for (const type of Object.values(uploadMimeTypeByExtension)) expect(uploadMimeTypes).toContain(type);
  });
});
