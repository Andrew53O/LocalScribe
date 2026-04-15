import { createReadStream } from "node:fs";
import type { LanguageHint, WhisperSegment } from "../../shared/types.js";

export interface OpenAITranscriptionInput {
  audioPath: string;
  languageHint: LanguageHint;
  glossary?: string;
}

export async function transcribeWithOpenAI(input: OpenAITranscriptionInput): Promise<WhisperSegment[]> {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is required for OpenAI transcription mode.");
  }

  const { default: OpenAI } = await import("openai");
  const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  const transcription = await client.audio.transcriptions.create({
    file: createReadStream(input.audioPath),
    model: "gpt-4o-transcribe",
    response_format: "json",
    prompt: buildPrompt(input.languageHint, input.glossary)
  });

  const text = transcription.text?.trim() ?? "";
  return [
    {
      start: 0,
      end: Math.max(1, text.length / 12),
      text
    }
  ];
}

function buildPrompt(languageHint: LanguageHint, glossary = "") {
  const language =
    languageHint === "zh-TW"
      ? "Prefer Traditional Chinese Taiwan output."
      : languageHint === "id"
        ? "Main language is Indonesian."
        : languageHint === "en"
          ? "Main language is English."
          : "Detect English, Traditional Chinese Taiwan, Indonesian, and mixed speech.";

  return [language, "Preserve English words used inside Chinese or Indonesian speech.", glossary.trim()].filter(Boolean).join(" ");
}
