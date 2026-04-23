import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  buildCachedSourceYtDlpArgs,
  buildChunkPlan,
  buildDirectSegmentYtDlpArgs,
  findCachedYoutubeSource,
  getYoutubeCacheKey,
  getYoutubeVideoCacheDir,
  readYoutubeCacheMetadata,
  writeYoutubeCacheMetadata
} from "../src/server/services/audio";

describe("audio chunk planning", () => {
  it("builds 90 second chunks for long ranges", () => {
    expect(buildChunkPlan(200)).toEqual([
      { index: 0, startSeconds: 0, durationSeconds: 90 },
      { index: 1, startSeconds: 90, durationSeconds: 90 },
      { index: 2, startSeconds: 180, durationSeconds: 20 }
    ]);
  });

  it("returns no chunks for empty duration", () => {
    expect(buildChunkPlan(0)).toEqual([]);
  });
});

describe("YouTube audio cache helpers", () => {
  it("builds safe cache keys and cache paths", () => {
    const key = getYoutubeCacheKey({ id: "abc/123", durationSeconds: 90 }, "https://youtube.com/watch?v=abc/123");
    expect(key).toBe("abc_123");
    expect(getYoutubeVideoCacheDir("cache-root", key)).toBe(path.join("cache-root", "abc_123"));
  });

  it("finds cached source audio and ignores partial/json files", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "audio-cache-test-"));

    try {
      await writeFile(path.join(tempDir, "source.webm.part"), "partial");
      await writeFile(path.join(tempDir, "source.json"), "{}");
      await writeFile(path.join(tempDir, "source.webm"), "audio");

      expect(await findCachedYoutubeSource(tempDir)).toBe(path.join(tempDir, "source.webm"));
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reads and writes cache metadata", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "audio-cache-meta-test-"));
    const metadataPath = path.join(tempDir, "metadata.json");

    try {
      await mkdir(tempDir, { recursive: true });
      await writeYoutubeCacheMetadata(metadataPath, {
        id: "video-id",
        title: "Video title",
        sourceUrl: "https://youtube.com/watch?v=video-id",
        durationSeconds: 120,
        cachedFileName: "source.webm",
        cachedAt: "2026-04-23T00:00:00.000Z"
      });

      expect(await readYoutubeCacheMetadata(metadataPath)).toEqual({
        id: "video-id",
        title: "Video title",
        sourceUrl: "https://youtube.com/watch?v=video-id",
        durationSeconds: 120,
        cachedFileName: "source.webm",
        cachedAt: "2026-04-23T00:00:00.000Z"
      });
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("builds full source and direct segment yt-dlp commands", () => {
    const cachedArgs = buildCachedSourceYtDlpArgs("https://youtube.com/watch?v=abc", "cache/source.%(ext)s");
    expect(cachedArgs).toContain("-f");
    expect(cachedArgs).toContain("bestaudio/best");
    expect(cachedArgs).not.toContain("--download-sections");

    const directArgs = buildDirectSegmentYtDlpArgs("https://youtube.com/watch?v=abc", "*00:00:00-00:01:00", "tmp/source.%(ext)s");
    expect(directArgs).toContain("--download-sections");
    expect(directArgs).toContain("*00:00:00-00:01:00");
  });
});
