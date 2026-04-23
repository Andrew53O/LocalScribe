import { describe, expect, it } from "vitest";
import { isSupportedYoutubeUrl, transcriptionRequestSchema, uploadTranscriptionRequestSchema } from "../src/server/lib/validation";

const commonFields = {
  startTime: "00:00:00",
  endTime: "00:01:00",
  languageHint: "auto",
  provider: "local",
  localModel: "large-v3-turbo-q8_0",
  glossary: "",
  convertToTraditional: true,
  localSpeed: {
    beamSize: 5,
    bestOf: 5,
    threads: 4,
    vadEnabled: false
  }
};

describe("transcription request validation", () => {
  it("accepts standard, short, shorts, and live YouTube URLs", () => {
    expect(isSupportedYoutubeUrl("https://www.youtube.com/watch?v=abc123")).toBe(true);
    expect(isSupportedYoutubeUrl("https://youtu.be/abc123")).toBe(true);
    expect(isSupportedYoutubeUrl("https://youtube.com/shorts/abc123")).toBe(true);
    expect(isSupportedYoutubeUrl("https://www.youtube.com/live/G0UlbOuYNik")).toBe(true);
  });

  it("rejects non-YouTube URLs", () => {
    expect(isSupportedYoutubeUrl("https://example.com/watch?v=abc123")).toBe(false);
  });

  it("accepts YouTube JSON requests by default", () => {
    const parsed = transcriptionRequestSchema.parse({
      ...commonFields,
      youtubeUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    });

    expect(parsed.sourceType).toBe("youtube");
    expect(parsed.youtubeUrl).toContain("youtube.com");
    expect(parsed.youtubeExtractionMode).toBe("cache-first");
  });

  it("accepts uploaded media requests with multipart-style string fields", () => {
    const parsed = uploadTranscriptionRequestSchema.parse({
      sourceType: "upload",
      startTime: "00:00:10",
      endTime: "00:00:30",
      languageHint: "zh-TW",
      provider: "local",
      localModel: "large-v3-turbo-q8_0",
      glossary: "OpenAI",
      convertToTraditional: "true",
      localSpeed: JSON.stringify({
        beamSize: 2,
        bestOf: 2,
        threads: 8,
        vadEnabled: true
      }),
      uploadFilePath: "C:\\Temp\\clip.mp4",
      uploadFileName: "clip.mp4",
      uploadMimeType: "video/mp4"
    });

    expect(parsed.sourceType).toBe("upload");
    expect(parsed.convertToTraditional).toBe(true);
    expect(parsed.localSpeed.threads).toBe(8);
    expect(parsed.localSpeed.vadEnabled).toBe(true);
  });
});
