import { describe, expect, it } from "vitest";
import { buildWhisperArgs, parseWhisperJson } from "../src/server/services/whisper";

describe("whisper.cpp integration helpers", () => {
  it("builds a multilingual local whisper command", () => {
    const args = buildWhisperArgs({
      audioPath: "segment.wav",
      workDir: "tmp",
      languageHint: "zh-TW",
      glossary: "OpenAI, Kubernetes",
      config: {
        whisperBin: "whisper-cli",
        modelPath: "model.bin",
        modelName: "large-v3-turbo-q8_0"
      }
    });

    expect(args).toContain("model.bin");
    expect(args).toContain("segment.wav");
    expect(args).toContain("zh");
    expect(args).toContain("--prompt");
    expect(args).toContain("以下是繁體中文逐字稿，包含術語：OpenAI, Kubernetes");
  });

  it("does not pass English instruction prompts for Chinese transcription", () => {
    const args = buildWhisperArgs({
      audioPath: "segment.wav",
      workDir: "tmp",
      languageHint: "zh-TW",
      config: {
        whisperBin: "whisper-cli",
        modelPath: "model.bin",
        modelName: "large-v3-turbo-q8_0"
      }
    });

    expect(args).toContain("zh");
    expect(args).not.toContain("--prompt");
    expect(args.join(" ")).not.toContain("Do not translate");
  });

  it("uses whisper auto-detect for mixed language mode", () => {
    const args = buildWhisperArgs({
      audioPath: "segment.wav",
      workDir: "tmp",
      languageHint: "auto",
      config: {
        whisperBin: "whisper-cli",
        modelPath: "model.bin",
        modelName: "large-v3-turbo-q8_0"
      }
    });

    expect(args).toContain("-l");
    expect(args).toContain("auto");
    expect(args).not.toContain("-nt");
  });

  it("parses whisper.cpp JSON output", () => {
    const segments = parseWhisperJson(
      JSON.stringify({
        transcription: [
          {
            timestamps: { from: "00:00:01,000", to: "00:00:04,000" },
            text: "Hello world."
          }
        ]
      })
    );

    expect(segments[0]).toEqual({
      start: 1,
      end: 4,
      text: "Hello world.",
      confidence: undefined
    });
  });
});
