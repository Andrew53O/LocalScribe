import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { GpuStatus } from "../../shared/types.js";
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
  gpu: GpuStatus;
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
  const gpu = await getGpuStatus(whisperBin);

  return {
    ok: tools.every((tool) => tool.ok),
    tools,
    gpu
  };
}

async function getGpuStatus(whisperBin: string | undefined): Promise<GpuStatus> {
  if (!whisperBin) {
    return {
      backend: "cpu",
      available: false,
      devices: []
    };
  }

  let devices: string[] = [];
  let backend: GpuStatus["backend"] = "cpu";

  try {
    const { stderr } = await runCommand(whisperBin, ["--help"], { timeoutMs: 15000 });
    const lines = stderr.split(/\r?\n/);
    devices = lines
      .map((line) => /Device \d+:\s*([^,]+),/i.exec(line)?.[1]?.trim())
      .filter((device): device is string => Boolean(device));
    backend = devices.length > 0 ? "cuda" : "cpu";
  } catch {
    return {
      backend: "cpu",
      available: false,
      devices: []
    };
  }

  try {
    const { stdout } = await runCommand(
      "nvidia-smi",
      [
        "--query-gpu=name,driver_version,utilization.gpu,memory.used,memory.total",
        "--format=csv,noheader,nounits"
      ],
      { timeoutMs: 10000 }
    );
    const first = stdout.split(/\r?\n/).find((line) => line.trim().length > 0);

    if (!first) {
      return {
        backend,
        available: devices.length > 0,
        devices
      };
    }

    const [name, driverVersion, utilizationPercent, memoryUsedMiB, memoryTotalMiB] = first.split(",").map((value) => value.trim());

    return {
      backend,
      available: devices.length > 0,
      devices: devices.length > 0 ? devices : [name],
      driverVersion,
      utilizationPercent: Number.parseFloat(utilizationPercent),
      memoryUsedMiB: Number.parseFloat(memoryUsedMiB),
      memoryTotalMiB: Number.parseFloat(memoryTotalMiB)
    };
  } catch {
    return {
      backend,
      available: devices.length > 0,
      devices
    };
  }
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
