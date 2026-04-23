export type LanguageHint = "auto" | "en" | "zh-TW" | "id";

export type Provider = "local" | "openai";

export type LocalModel = "large-v3-turbo-q8_0" | "large-v3-turbo-q5_0" | "large-v3";

export type JobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export type TranscriptionSource = "youtube" | "upload";

export type YouTubeExtractionMode = "cache-first" | "direct-segment";

export interface LocalSpeedSettings {
  beamSize: number;
  bestOf: number;
  threads: number;
  vadEnabled: boolean;
}

export interface GpuStatus {
  backend: "cuda" | "cpu";
  available: boolean;
  devices: string[];
  driverVersion?: string;
  utilizationPercent?: number;
  memoryUsedMiB?: number;
  memoryTotalMiB?: number;
}

export interface ToolStatus {
  key: "ytDlp" | "ffmpeg" | "whisperBin";
  label: string;
  ok: boolean;
  path?: string;
  error?: string;
}

export interface LocalModelStatus {
  model: LocalModel;
  label: string;
  envVar: string;
  ok: boolean;
  path?: string;
  fallbackPath?: string;
  error?: string;
}

export interface BaseTranscriptionRequest {
  sourceType: TranscriptionSource;
  startTime: string;
  endTime: string;
  languageHint: LanguageHint;
  provider: Provider;
  localModel: LocalModel;
  glossary?: string;
  convertToTraditional?: boolean;
  localSpeed: LocalSpeedSettings;
}

export interface YouTubeTranscriptionRequest extends BaseTranscriptionRequest {
  sourceType: "youtube";
  youtubeUrl: string;
  youtubeExtractionMode: YouTubeExtractionMode;
}

export interface UploadTranscriptionRequest extends BaseTranscriptionRequest {
  sourceType: "upload";
  uploadFilePath: string;
  uploadFileName: string;
  uploadMimeType?: string;
}

export type TranscriptionRequest = YouTubeTranscriptionRequest | UploadTranscriptionRequest;

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
  partial: boolean;
  completedChunks?: number;
  totalChunks?: number;
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
