import { describe, expect, test } from "bun:test";
import { transcriptExportQuerySchema } from "./projects";

describe("transcriptExportQuerySchema", () => {
  test("defaults to a text file and accepts the three formats", () => {
    expect(transcriptExportQuerySchema.parse({}).format).toBe("txt");
    for (const format of ["txt", "srt", "vtt"]) {
      expect(transcriptExportQuerySchema.parse({ format }).format).toBe(format);
    }
  });

  test("refuses any other format", () => {
    expect(transcriptExportQuerySchema.safeParse({ format: "docx" }).success).toBe(false);
  });
});
