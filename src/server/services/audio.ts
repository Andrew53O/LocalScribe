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

export interface ExtractLocalMediaInput {
  sourcePath: string;
  startSeconds: number;
  endSeconds: number;
  workDir: string;
  tools: Pick<AudioTools, "ffmpegBin">;
  onProgress?: (progress: AudioExtractionProgress) => void;
}

export interface AudioExtractionProgress {
  phase: "prepare" | "download" | "convert";
  percent: number;
  processedSeconds: number;
  totalSeconds: number;
  remainingSeconds: number;
  detail?: string;
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
  const durationSeconds = input.endSeconds - input.startSeconds;

  input.onProgress?.(buildExtractionProgress("prepare", 0, durationSeconds, "Starting yt-dlp"));

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
      onStdout: (chunk) =>
        reportYtDlpProgress(chunk, durationSeconds, input.onProgress),
      onStderr: (chunk) =>
        reportYtDlpProgress(chunk, durationSeconds, input.onProgress)
    }
  );
  input.onProgress?.(buildExtractionProgress("download", 100, durationSeconds));

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
        reportFfmpegProgress(chunk, durationSeconds, input.onProgress)
    }
  );
  input.onProgress?.(buildExtractionProgress("convert", 100, durationSeconds));

  return normalizedPath;
}

export async function extractLocalMediaSegmentAudio(input: ExtractLocalMediaInput): Promise<string> {
  await mkdir(input.workDir, { recursive: true });
  const durationSeconds = input.endSeconds - input.startSeconds;
  const normalizedPath = path.join(input.workDir, "segment.wav");

  input.onProgress?.(buildExtractionProgress("prepare", 0, durationSeconds, "Opening uploaded media"));

  await runCommand(
    input.tools.ffmpegBin,
    [
      "-y",
      "-ss",
      String(input.startSeconds),
      "-t",
      String(durationSeconds),
      "-i",
      input.sourcePath,
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
      timeoutMs: 1000 * 60 * 30,
      onStderr: (chunk) =>
        reportFfmpegProgress(chunk, durationSeconds, input.onProgress)
    }
  );
  input.onProgress?.(buildExtractionProgress("convert", 100, durationSeconds));

  return normalizedPath;
}

function reportYtDlpProgress(
  chunk: string,
  durationSeconds: number,
  onProgress: ExtractAudioInput["onProgress"]
) {
  if (!onProgress) {
    return;
  }

  const clean = stripAnsi(chunk);
  const matches = clean.matchAll(/\[download\]\s+(\d+(?:\.\d+)?)%/gi);
  let foundDownloadProgress = false;

  for (const match of matches) {
    foundDownloadProgress = true;
    onProgress(buildExtractionProgress("download", Number.parseFloat(match[1]), durationSeconds));
  }

  if (!foundDownloadProgress) {
    for (const line of clean.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      const detail = parseYtDlpPreparationLine(line);
      if (detail) {
        onProgress(buildExtractionProgress("prepare", 0, durationSeconds, detail));
      }
    }
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
    onProgress(buildExtractionProgress("convert", (processedSeconds / durationSeconds) * 100, durationSeconds));
  }
}

function buildExtractionProgress(
  phase: AudioExtractionProgress["phase"],
  percent: number,
  durationSeconds: number,
  detail?: string
): AudioExtractionProgress {
  const safeDuration = Math.max(0, durationSeconds);
  const safePercent = clampPercent(percent);
  const processedSeconds = Math.min(safeDuration, (safePercent / 100) * safeDuration);

  return {
    phase,
    percent: safePercent,
    processedSeconds,
    totalSeconds: safeDuration,
    remainingSeconds: Math.max(0, safeDuration - processedSeconds),
    detail
  };
}

function parseYtDlpPreparationLine(line: string): string | undefined {
  if (line.startsWith("[youtube] Extracting URL")) {
    return "Reading YouTube URL";
  }

  if (line.includes("Downloading webpage")) {
    return "Downloading video page";
  }

  if (line.includes("Downloading ios player API JSON")) {
    return "Checking iOS player metadata";
  }

  if (line.includes("Downloading android player API JSON")) {
    return "Checking Android player metadata";
  }

  if (line.includes("Downloading m3u8 information")) {
    return "Reading audio stream playlist";
  }

  if (line.includes("Downloading player")) {
    return "Downloading YouTube player metadata";
  }

  if (line.startsWith("[info]")) {
    return "Selecting best audio stream";
  }

  if (line.startsWith("[download] Destination:")) {
    return "Opening local audio output file";
  }

  return undefined;
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
