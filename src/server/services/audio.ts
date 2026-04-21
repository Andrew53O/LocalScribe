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
  onProgress?: (progress: AudioExtractionProgress) => void;
}

export interface AudioExtractionProgress {
  phase: "download" | "convert";
  percent: number;
}

export interface VideoMetadata {
  id?: string;
  title?: string;
  durationSeconds: number;
}

export interface AudioChunk {
  index: number;
  startSeconds: number;
  durationSeconds: number;
  audioPath: string;
}

export async function extractSegmentAudio(input: ExtractAudioInput): Promise<string> {
  await mkdir(input.workDir, { recursive: true });
  const rawTemplate = path.join(input.workDir, "source.%(ext)s");
  const section = `*${formatTimestamp(input.startSeconds)}-${formatTimestamp(input.endSeconds)}`;

  await runCommand(
    input.tools.ytDlpBin,
    [
      "--no-playlist",
      "--newline",
      "--download-sections",
      section,
      "-f",
      "bestaudio/best",
      "-o",
      rawTemplate,
      input.youtubeUrl
    ],
    {
      timeoutMs: 1000 * 60 * 30,
      onStdout: (chunk) => reportYtDlpProgress(chunk, input.onProgress),
      onStderr: (chunk) => reportYtDlpProgress(chunk, input.onProgress)
    }
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
      "-c:a",
      "pcm_s16le",
      "-ac",
      "1",
      "-ar",
      "16000",
      normalizedPath
    ],
    {
      timeoutMs: 1000 * 60 * 20,
      onStderr: (chunk) =>
        reportFfmpegProgress(chunk, input.endSeconds - input.startSeconds, input.onProgress)
    }
  );

  return normalizedPath;
}

function reportYtDlpProgress(
  chunk: string,
  onProgress: ExtractAudioInput["onProgress"]
) {
  if (!onProgress) {
    return;
  }

  const clean = stripAnsi(chunk);
  const matches = clean.matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/gi);

  for (const match of matches) {
    onProgress({
      phase: "download",
      percent: clampPercent(Number.parseFloat(match[1]))
    });
  }
}

function reportFfmpegProgress(
  chunk: string,
  durationSeconds: number,
  onProgress: ExtractAudioInput["onProgress"]
) {
  if (!onProgress || durationSeconds <= 0) {
    return;
  }

  const clean = stripAnsi(chunk);
  const matches = clean.matchAll(/time=(\d{2}):(\d{2}):(\d{2}(?:\.\d+)?)/gi);

  for (const match of matches) {
    const processedSeconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number.parseFloat(match[3]);
    onProgress({
      phase: "convert",
      percent: clampPercent((processedSeconds / durationSeconds) * 100)
    });
  }
}

function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }

  return Math.max(0, Math.min(100, value));
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

export async function createAudioChunk(
  audioPath: string,
  chunkIndex: number,
  startSeconds: number,
  durationSeconds: number,
  workDir: string,
  ffmpegBin: string
): Promise<AudioChunk> {
  const chunkPath = path.join(workDir, `chunk-${String(chunkIndex + 1).padStart(3, "0")}.wav`);

  await runCommand(
    ffmpegBin,
    [
      "-y",
      "-ss",
      String(startSeconds),
      "-t",
      String(durationSeconds),
      "-i",
      audioPath,
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      chunkPath
    ],
    { timeoutMs: 1000 * 60 * 10 }
  );

  return {
    index: chunkIndex,
    startSeconds,
    durationSeconds,
    audioPath: chunkPath
  };
}

export function buildChunkPlan(totalDurationSeconds: number, chunkDurationSeconds = 90): Array<Pick<AudioChunk, "index" | "startSeconds" | "durationSeconds">> {
  const safeDuration = Math.max(0, totalDurationSeconds);
  const plan: Array<Pick<AudioChunk, "index" | "startSeconds" | "durationSeconds">> = [];
  let startSeconds = 0;
  let index = 0;

  while (startSeconds < safeDuration) {
    const durationSeconds = Math.min(chunkDurationSeconds, safeDuration - startSeconds);
    plan.push({
      index,
      startSeconds,
      durationSeconds
    });
    startSeconds += durationSeconds;
    index += 1;
  }

  return plan;
}
