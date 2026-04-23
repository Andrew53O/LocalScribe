import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { getLocalModelStatus, modelEnvName, modelPathMatchesSelection } from "../src/server/lib/models";

describe("local model configuration", () => {
  it("maps local models to their env vars", () => {
    expect(modelEnvName("large-v3-turbo-q8_0")).toBe("WHISPER_MODEL_PATH_LARGE_V3_TURBO_Q8_0");
    expect(modelEnvName("large-v3-turbo-q5_0")).toBe("WHISPER_MODEL_PATH_LARGE_V3_TURBO_Q5_0");
    expect(modelEnvName("large-v3")).toBe("WHISPER_MODEL_PATH_LARGE_V3");
  });

  it("matches selected model names against model filenames", () => {
    expect(modelPathMatchesSelection("models/ggml-large-v3-turbo-q8_0.bin", "large-v3-turbo-q8_0")).toBe(true);
    expect(modelPathMatchesSelection("models/ggml-large-v3-turbo-q5_0.bin", "large-v3-turbo-q5_0")).toBe(true);
    expect(modelPathMatchesSelection("models/ggml-large-v3.bin", "large-v3")).toBe(true);
    expect(modelPathMatchesSelection("models/ggml-large-v3-turbo-q8_0.bin", "large-v3")).toBe(false);
  });

  it("reports model-specific readiness with fallback support", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "model-status-test-"));
    const previousSpecific = process.env.WHISPER_MODEL_PATH_LARGE_V3_TURBO_Q8_0;
    const previousFallback = process.env.WHISPER_MODEL_PATH;

    try {
      const modelPath = path.join(tempDir, "ggml-large-v3-turbo-q8_0.bin");
      await writeFile(modelPath, "model");
      delete process.env.WHISPER_MODEL_PATH_LARGE_V3_TURBO_Q8_0;
      process.env.WHISPER_MODEL_PATH = modelPath;

      await expect(getLocalModelStatus("large-v3-turbo-q8_0")).resolves.toMatchObject({
        model: "large-v3-turbo-q8_0",
        ok: true,
        path: modelPath
      });
    } finally {
      if (previousSpecific === undefined) {
        delete process.env.WHISPER_MODEL_PATH_LARGE_V3_TURBO_Q8_0;
      } else {
        process.env.WHISPER_MODEL_PATH_LARGE_V3_TURBO_Q8_0 = previousSpecific;
      }

      if (previousFallback === undefined) {
        delete process.env.WHISPER_MODEL_PATH;
      } else {
        process.env.WHISPER_MODEL_PATH = previousFallback;
      }

      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
