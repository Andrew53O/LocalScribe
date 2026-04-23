import path from "node:path";
import { rm } from "node:fs/promises";

export function getYoutubeCacheRoot(): string {
  return path.resolve(process.env.YOUTUBE_CACHE_DIR || path.join(process.cwd(), ".cache", "scribelocal", "youtube"));
}

export async function clearYoutubeCache(): Promise<{ cacheDir: string }> {
  const cacheDir = getYoutubeCacheRoot();
  await rm(cacheDir, { recursive: true, force: true });

  return { cacheDir };
}
