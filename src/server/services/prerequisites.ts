import type { GpuStatus, LocalModelStatus, ToolStatus } from "../../shared/types.js";
import { getLocalModelStatuses } from "../lib/models.js";
import { runCommand } from "./process.js";

export interface PrerequisiteStatus {
  ok: boolean;
  tools: ToolStatus[];
  models: LocalModelStatus[];
  gpu: GpuStatus;
}

export async function getLocalPrerequisiteStatus(): Promise<PrerequisiteStatus> {
  const ytDlpBin = process.env.YTDLP_BIN || "yt-dlp";
  const ffmpegBin = process.env.FFMPEG_BIN || "ffmpeg";
  const whisperBin = process.env.WHISPER_CPP_BIN;

  const [tools, models] = await Promise.all([
    Promise.all([
      checkCommand("ytDlp", "yt-dlp", ytDlpBin, ["--version"]),
      checkCommand("ffmpeg", "ffmpeg", ffmpegBin, ["-version"]),
      checkCommand("whisperBin", "whisper.cpp", whisperBin, ["--help"])
    ]),
    getLocalModelStatuses()
  ]);
  const gpu = await getGpuStatus(whisperBin);

  return {
    ok: tools.every((tool) => tool.ok) && models.some((model) => model.ok),
    tools,
    models,
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
