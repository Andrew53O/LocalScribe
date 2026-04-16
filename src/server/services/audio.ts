import { mkdir, readdir } from "node:fs/promises";
import path from "node:path";
import { formatTimestamp } from "../lib/time.js";
import { runCommand } from "./process.js";

export interface AudioTools {
  ytDlpBin: string;
  ffmpegBin: string;
}

export interface ExtractAudioInput {
  youtubeUrl: string;
  startSeconds: number;
  endSeconds: number;
  workDir: string;
  tools: AudioTools;
}

export interface VideoMetadata {
  id?: string;
  title?: string;
  durationSeconds: number;
}

export async function extractSegmentAudio(input: ExtractAudioInput): Promise<string> {
  await mkdir(input.workDir, { recursive: true });
  const rawTemplate = path.join(input.workDir, "source.%(ext)s");
  const section = `*${formatTimestamp(input.startSeconds)}-${formatTimestamp(input.endSeconds)}`;

  await runCommand(
    input.tools.ytDlpBin,
    [
      "--no-playlist",
      "--force-keyframes-at-cuts",
      "--download-sections",
      section,
      "-f",
      "bestaudio/best",
      "-o",
      rawTemplate,
      input.youtubeUrl
    ],
    { timeoutMs: 1000 * 60 * 30 }
  );

  const files = await readdir(input.workDir);
  const sourceFile = files.find((file) => file.startsWith("source.") && !file.endsWith(".part"));

  if (!sourceFile) {
    throw new Error("yt-dlp did not produce an audio file.");
  }

  const normalizedPath = path.join(input.workDir, "segment.wav");

  await runCommand(
    input.tools.ffmpegBin,
    [
      "-y",
      "-i",
      path.join(input.workDir, sourceFile),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-af",
      "loudnorm",
      normalizedPath
    ],
    { timeoutMs: 1000 * 60 * 20 }
  );

  return normalizedPath;
}

export async function getYoutubeVideoMetadata(youtubeUrl: string, ytDlpBin: string): Promise<VideoMetadata> {
  const { stdout } = await runCommand(
    ytDlpBin,
    ["--no-playlist", "--dump-single-json", "--no-warnings", youtubeUrl],
    { timeoutMs: 1000 * 60 * 2 }
  );

  const parsed = JSON.parse(stdout) as { duration?: number; title?: string; id?: string };

  if (!parsed.duration || parsed.duration <= 0) {
    throw new Error("Could not determine the video duration.");
  }

  return {
    id: parsed.id,
    title: parsed.title,
    durationSeconds: parsed.duration
  };
}
