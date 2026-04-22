import { z } from "zod";

const booleanInput = z.preprocess((value) => {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return value;
}, z.boolean());

const localSpeedSchema = z.preprocess((value) => {
  if (typeof value !== "string") {
    return value;
  }

  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}, z.object({
  beamSize: z.coerce.number().int().min(1).max(10).default(5),
  bestOf: z.coerce.number().int().min(1).max(10).default(5),
  threads: z.coerce.number().int().min(1).max(32).default(4),
  vadEnabled: booleanInput.default(false)
}).default({
  beamSize: 5,
  bestOf: 5,
  threads: 4,
  vadEnabled: false
}));

const baseTranscriptionRequestSchema = z.object({
  youtubeUrl: z.string().url().refine(isSupportedYoutubeUrl, "Enter a valid YouTube URL."),
  startTime: z.string().min(4),
  endTime: z.string().min(4),
  languageHint: z.enum(["auto", "en", "zh-TW", "id"]),
  provider: z.enum(["local", "openai"]).default("local"),
  localModel: z.enum(["large-v3-turbo-q8_0", "large-v3-turbo-q5_0", "large-v3"]).default("large-v3-turbo-q8_0"),
  glossary: z.string().max(2000).optional().default(""),
  convertToTraditional: booleanInput.optional().default(true),
  localSpeed: localSpeedSchema
});

export const transcriptionRequestSchema = baseTranscriptionRequestSchema.extend({
  sourceType: z.literal("youtube").optional().default("youtube")
});

export const uploadTranscriptionRequestSchema = baseTranscriptionRequestSchema
  .omit({ youtubeUrl: true })
  .extend({
    sourceType: z.literal("upload"),
    uploadFilePath: z.string().min(1),
    uploadFileName: z.string().min(1),
    uploadMimeType: z.string().optional()
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
