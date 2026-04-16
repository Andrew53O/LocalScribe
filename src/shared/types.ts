export type LanguageHint = "auto" | "en" | "zh-TW" | "id";

export type Provider = "local" | "openai";

export type LocalModel = "large-v3-turbo-q8_0" | "large-v3-turbo-q5_0" | "large-v3";

export type JobStatus = "queued" | "running" | "completed" | "failed";

export interface TranscriptionRequest {
  youtubeUrl: string;
  startTime: string;
  endTime: string;
  languageHint: LanguageHint;
  provider: Provider;
  localModel: LocalModel;
  glossary?: string;
  convertToTraditional?: boolean;
}

export interface Highlight {
  startChar: number;
  endChar: number;
  severity: "warning" | "danger";
  reason: string;
  confidence?: number;
}

export interface TranscriptSentence {
  startSeconds: number;
  endSeconds: number;
  text: string;
  detectedLanguage: LanguageHint;
  speakerLabel: string;
  qualityStatus: "ok" | "review";
  highlights: Highlight[];
}

export interface TranscriptionResult {
  sourceUsed: "audio-transcription";
  provider: Provider;
  model: string;
  durationSeconds: number;
  sentences: TranscriptSentence[];
}

export interface JobRecord {
  id: string;
  status: JobStatus;
  progress: number;
  message: string;
  createdAt: string;
  updatedAt: string;
  error?: string;
  result?: TranscriptionResult;
}

export interface WhisperSegment {
  start: number;
  end: number;
  text: string;
  confidence?: number;
}
