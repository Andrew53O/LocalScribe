import { readFile } from "node:fs/promises";
import path from "node:path";
import type { LanguageHint, LocalModel, LocalSpeedSettings, WhisperSegment } from "../../shared/types.js";
import { runCommand } from "./process.js";

export interface WhisperConfig {
  whisperBin: string;
  modelPath: string;
  modelName: LocalModel;
  speed: LocalSpeedSettings;
}

export interface WhisperInput {
  audioPath: string;
  workDir: string;
  languageHint: LanguageHint;
  glossary?: string;
  config: WhisperConfig;
  signal?: AbortSignal;
}

export function buildWhisperArgs(input: WhisperInput): string[] {
  const outputBase = path.join(input.workDir, "whisper-output");
  const args = [
    "-m",
    input.config.modelPath,
    "-f",
    input.audioPath,
    "-t",
    String(input.config.speed.threads),
    "-bs",
    String(input.config.speed.beamSize),
    "-bo",
    String(input.config.speed.bestOf),
    "-oj",
    "-osrt",
    "-otxt",
    "-of",
    outputBase,
    "-ojf",
    "-pp"
  ];

  const language = mapLanguage(input.languageHint);
  if (language) {
    args.push("-l", language);
  }

  const prompt = buildPrompt(input.languageHint, input.glossary);
  if (prompt) {
    args.push("--prompt", prompt);
  }

  if (input.config.speed.vadEnabled) {
    args.push("--vad");
  }

  return args;
}

export async function transcribeWithWhisper(input: WhisperInput): Promise<WhisperSegment[]> {
  const args = buildWhisperArgs(input);
  await runCommand(input.config.whisperBin, args, { timeoutMs: 1000 * 60 * 60 * 4, signal: input.signal });

  const outputBase = path.join(input.workDir, "whisper-output");

  try {
    const raw = await readFile(`${outputBase}.json`, "utf8");
    return parseWhisperJson(raw);
  } catch {
    const text = await readFile(`${outputBase}.txt`, "utf8");
    return [
      {
        start: 0,
        end: Math.max(1, text.length / 12),
        text: text.trim()
      }
    ];
  }
}

export function parseWhisperJson(raw: string): WhisperSegment[] {
  const parsed = JSON.parse(raw) as {
    transcription?: Array<{
      text?: string;
      timestamps?: { from?: string; to?: string };
      offsets?: { from?: number; to?: number };
      confidence?: number;
    }>;
    segments?: Array<{
      text?: string;
      start?: number;
      end?: number;
      avg_logprob?: number;
    }>;
  };

  if (Array.isArray(parsed.transcription)) {
    return parsed.transcription
      .map((item) => ({
        start: parseWhisperTimestamp(item.timestamps?.from) ?? offsetToSeconds(item.offsets?.from) ?? 0,
        end: parseWhisperTimestamp(item.timestamps?.to) ?? offsetToSeconds(item.offsets?.to) ?? 0,
        text: item.text?.trim() ?? "",
        confidence: item.confidence
      }))
      .filter((item) => item.text.length > 0);
  }

  if (Array.isArray(parsed.segments)) {
    return parsed.segments
      .map((item) => ({
        start: item.start ?? 0,
        end: item.end ?? item.start ?? 0,
        text: item.text?.trim() ?? "",
        confidence: item.avg_logprob !== undefined ? Math.exp(item.avg_logprob) : undefined
      }))
      .filter((item) => item.text.length > 0);
  }

  throw new Error("Unsupported whisper.cpp JSON output.");
}

function buildPrompt(languageHint: LanguageHint, glossary = ""): string {
  const terms = glossary.trim();

  if (!terms) {
    return "";
  }

  if (languageHint === "zh-TW") {
    return `以下是繁體中文逐字稿，包含術語：${terms}`;
  }

  if (languageHint === "id") {
    return `Transkrip bahasa Indonesia dengan istilah: ${terms}`;
  }

  if (languageHint === "en") {
    return `English transcript terms: ${terms}`;
  }

  return terms;
}

function mapLanguage(languageHint: LanguageHint): string | undefined {
  if (languageHint === "auto") {
    return "auto";
  }

  if (languageHint === "zh-TW") {
    return "zh";
  }

  return languageHint;
}

function parseWhisperTimestamp(value?: string): number | undefined {
  if (!value) {
    return undefined;
  }

  const match = /(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/.exec(value);
  if (!match) {
    return undefined;
  }

  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
}

function offsetToSeconds(value?: number): number | undefined {
  return value === undefined ? undefined : value / 1000;
}
