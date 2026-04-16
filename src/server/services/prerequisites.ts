import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import { runCommand } from "./process.js";

export interface ToolStatus {
  key: "ytDlp" | "ffmpeg" | "whisperBin" | "whisperModel";
  label: string;
  ok: boolean;
  path?: string;
  error?: string;
}

export interface PrerequisiteStatus {
  ok: boolean;
  tools: ToolStatus[];
}

export async function getLocalPrerequisiteStatus(): Promise<PrerequisiteStatus> {
  const ytDlpBin = process.env.YTDLP_BIN || "yt-dlp";
  const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
  const whisperBin = process.env.WHISPER_CPP_BIN;
  const whisperModel = process.env.WHISPER_MODEL_PATH;

  const tools = await Promise.all([
    checkCommand("ytDlp", "yt-dlp", ytDlpBin, ["--version"]),
    checkCommand("ffmpeg", "ffmpeg", ffmpegBin, ["-version"]),
    checkCommand("whisperBin", "whisper.cpp", whisperBin, ["--help"]),
    checkFile("whisperModel", "Whisper model", whisperModel)
  ]);

  return {
    ok: tools.every((tool) => tool.ok),
    tools
  };
}

async function checkCommand(
  key: ToolStatus["key"],
  label: string,
  commandPath: string | undefined,
  args: string[]
): Promise<ToolStatus> {
  if (!commandPath) {
    return {
      key,
      label,
      ok: false,
      error: `${label} path is not set.`
    };
  }

  try {
    await runCommand(commandPath, args, { timeoutMs: 15000 });
    return {
      key,
      label,
      ok: true,
      path: commandPath
    };
  } catch (error) {
    return {
      key,
      label,
      ok: false,
      path: commandPath,
      error: error instanceof Error ? error.message : `Unable to run ${label}.`
    };
  }
}

async function checkFile(
  key: ToolStatus["key"],
  label: string,
  filePath: string | undefined
): Promise<ToolStatus> {
  if (!filePath) {
    return {
      key,
      label,
      ok: false,
      error: `${label} path is not set.`
    };
  }

  try {
    await access(filePath, fsConstants.R_OK);
    return {
      key,
      label,
      ok: true,
      path: filePath
    };
  } catch (error) {
    return {
      key,
      label,
      ok: false,
      path: filePath,
      error: error instanceof Error ? error.message : `Unable to access ${label}.`
    };
  }
}
