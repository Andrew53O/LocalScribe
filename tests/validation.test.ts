import { describe, expect, it } from "vitest";
import { isSupportedYoutubeUrl } from "../src/server/lib/validation";

describe("YouTube URL validation", () => {
  it("accepts standard, short, shorts, and live URLs", () => {
    expect(isSupportedYoutubeUrl("https://www.youtube.com/watch?v=abc123")).toBe(true);
    expect(isSupportedYoutubeUrl("https://youtu.be/abc123")).toBe(true);
    expect(isSupportedYoutubeUrl("https://youtube.com/shorts/abc123")).toBe(true);
    expect(isSupportedYoutubeUrl("https://www.youtube.com/live/G0UlbOuYNik")).toBe(true);
  });

  it("rejects non-YouTube URLs", () => {
    expect(isSupportedYoutubeUrl("https://example.com/watch?v=abc123")).toBe(false);
  });
});
