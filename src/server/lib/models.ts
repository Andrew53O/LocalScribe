import { access } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import type { LocalModel, LocalModelStatus } from "../../shared/types.js";

export const LOCAL_MODEL_OPTIONS: Array<{ model: LocalModel; label: string; envVar: string }> = [
  {
    model: "large-v3-turbo-q8_0",
    label: "large-v3-turbo-q8_0",
    envVar: "WHISPER_MODEL_PATH_LARGE_V3_TURBO_Q8_0"
  },
  {
    model: "large-v3-turbo-q5_0",
    label: "large-v3-turbo-q5_0",
    envVar: "WHISPER_MODEL_PATH_LARGE_V3_TURBO_Q5_0"
  },
  {
    model: "large-v3",
    label: "large-v3",
    envVar: "WHISPER_MODEL_PATH_LARGE_V3"
  }
];

export async function getLocalModelStatuses(): Promise<LocalModelStatus[]> {
  return Promise.all(LOCAL_MODEL_OPTIONS.map((option) => getLocalModelStatus(option.model)));
}

export async function getLocalModelStatus(model: LocalModel): Promise<LocalModelStatus> {
  const option = getLocalModelOption(model);
  const specificPath = process.env[option.envVar];
  const fallbackPath = process.env.WHISPER_MODEL_PATH;
  const modelPath = specificPath || fallbackPath;

  if (!modelPath) {
    return {
      ...option,
      ok: false,
      error: `Set ${option.envVar} or WHISPER_MODEL_PATH.`
    };
  }

  if (!modelPathMatchesSelection(modelPath, model)) {
    return {
      ...option,
      ok: false,
      path: modelPath,
      fallbackPath: specificPath ? undefined : fallbackPath,
      error: `Configured file does not look like ${model}.`
    };
  }

  try {
    await access(modelPath, fsConstants.R_OK);
    return {
      ...option,
      ok: true,
      path: modelPath,
      fallbackPath: specificPath ? undefined : fallbackPath
    };
  } catch (error) {
    return {
      ...option,
      ok: false,
      path: modelPath,
      fallbackPath: specificPath ? undefined : fallbackPath,
      error: error instanceof Error ? error.message : `Unable to read ${modelPath}.`
    };
  }
}

export async function resolveSelectedModelPath(model: LocalModel): Promise<string> {
  const status = await getLocalModelStatus(model);

  if (!status.ok || !status.path) {
    throw new Error(
      `Selected local model ${model} is not ready. ${status.error ?? `Set ${status.envVar} in .env.`}`
    );
  }

  return status.path;
}

export function modelEnvName(model: LocalModel): string {
  return getLocalModelOption(model).envVar;
}

export function modelPathMatchesSelection(modelPath: string, modelName: LocalModel): boolean {
  const filename = path.basename(modelPath).toLowerCase();

  if (modelName === "large-v3") {
    return filename.includes("large-v3") && !filename.includes("turbo");
  }

  if (modelName === "large-v3-turbo-q5_0") {
    return filename.includes("large-v3-turbo") && filename.includes("q5_0");
  }

  return filename.includes("large-v3-turbo") && filename.includes("q8_0");
}

function getLocalModelOption(model: LocalModel) {
  const option = LOCAL_MODEL_OPTIONS.find((item) => item.model === model);

  if (!option) {
    throw new Error(`Unknown local model: ${model}`);
  }

  return option;
}
