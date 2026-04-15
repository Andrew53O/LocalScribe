import { z } from "zod";

export const transcriptionRequestSchema = z.object({
  youtubeUrl: z.string().url().refine(isSupportedYoutubeUrl, "Enter a valid YouTube URL."),
  startTime: z.string().min(4),
  endTime: z.string().min(4),
  languageHint: z.enum(["auto", "en", "zh-TW", "id"]),
  provider: z.enum(["local", "openai"]).default("local"),
  localModel: z.enum(["large-v3-turbo-q8_0", "large-v3-turbo-q5_0", "large-v3"]).default("large-v3-turbo-q8_0"),
  glossary: z.string().max(2000).optional().default(""),
  convertToTraditional: z.boolean().optional().default(true)
});

export function isSupportedYoutubeUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.length > 1;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      return url.searchParams.has("v") || hasPathVideoId(url.pathname, ["/shorts/", "/live/"]);
    }

    return false;
  } catch {
    return false;
  }
}

function hasPathVideoId(pathname: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => {
    if (!pathname.startsWith(prefix)) {
      return false;
    }

    return pathname.slice(prefix.length).split("/")[0].length > 0;
  });
}
