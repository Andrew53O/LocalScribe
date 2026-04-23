import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobRecord, TranscriptionRequest, TranscriptionResult, WhisperSegment } from "../../shared/types.js";
import { applyHeuristicSpeakerDiarization } from "../lib/diarization.js";
import { resolveSelectedModelPath } from "../lib/models.js";
import { applyQualityHighlights } from "../lib/quality.js";
import { segmentsToSentences } from "../lib/sentence.js";
import { formatTimestamp, validateRange } from "../lib/time.js";
import { convertBasicSimplifiedToTraditional } from "../lib/traditional.js";
import { buildChunkPlan, createAudioChunk, extractCachedYoutubeSegmentAudio, extractLocalMediaSegmentAudio, extractSegmentAudio, getYoutubeVideoMetadata, type VideoMetadata } from "./audio.js";
import { transcribeWithOpenAI } from "./openaiTranscription.js";
import { transcribeWithWhisper } from "./whisper.js";
import { getYoutubeCacheRoot } from "./youtubeCache.js";

const jobs = new Map<string, JobRecord>();
const jobLogState = new Map<string, { progress: number; stage: string }>();
const jobInputs = new Map<string, { request: TranscriptionRequest; metadata?: VideoMetadata }>();
const jobQueue: string[] = [];
const jobAbortControllers = new Map<string, AbortController>();
let activeJobId: string | null = null;

const PROGRESS = {
  validating: 5,
  extractionStart: 10,
  downloadEnd: 35,
  conversionEnd: 45,
  transcriptionStart: 45,
  transcriptionEnd: 90,
  review: 95,
  completed: 100
} as const;

export function createJob(request: TranscriptionRequest, metadata?: VideoMetadata): JobRecord {
  const now = new Date().toISOString();
  const job: JobRecord = {
    id: crypto.randomUUID(),
    status: "queued",
    progress: 0,
    message: "Queued",
    createdAt: now,
    updatedAt: now
  };

  jobs.set(job.id, job);
  jobInputs.set(job.id, { request, metadata });
  jobQueue.push(job.id);
  processJobQueue();

  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function cancelJob(id: string): JobRecord | undefined {
  const job = jobs.get(id);
  const input = jobInputs.get(id);

  if (!job) {
    return undefined;
  }

  if (job.status === "completed" || job.status === "failed" || job.status === "cancelled") {
    return job;
  }

  if (activeJobId === id) {
    updateJob(id, {
      status: "cancelled",
      progress: 100,
      message: "Cancelled"
    });
    jobAbortControllers.get(id)?.abort();
    return jobs.get(id);
  }

  const queuedIndex = jobQueue.indexOf(id);
  if (queuedIndex >= 0) {
    jobQueue.splice(queuedIndex, 1);
  }

  updateJob(id, {
    status: "cancelled",
    progress: 100,
    message: "Cancelled"
  });

  if (input) {
    void cleanupRequestUpload(input.request);
  }
  jobInputs.delete(id);

  return jobs.get(id);
}

function processJobQueue() {
  if (activeJobId) {
    return;
  }

  const nextJobId = jobQueue.shift();
  if (!nextJobId) {
    return;
  }

  const input = jobInputs.get(nextJobId);
  if (!input) {
    processJobQueue();
    return;
  }

  activeJobId = nextJobId;
  const abortController = new AbortController();
  jobAbortControllers.set(nextJobId, abortController);

  void runJob(nextJobId, input.request, input.metadata, abortController.signal)
    .finally(() => {
      jobAbortControllers.delete(nextJobId);
      jobInputs.delete(nextJobId);
      if (activeJobId === nextJobId) {
        activeJobId = null;
      }
      processJobQueue();
    });
}

async function runJob(jobId: string, request: TranscriptionRequest, metadata: VideoMetadata | undefined, signal: AbortSignal) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "yt-transcribe-"));

  try {
    assertNotCancelled(signal);
    updateJob(jobId, { status: "running", progress: PROGRESS.validating, message: "Validating time range" });
    const range = validateRange(request.startTime, request.endTime);
    const localModelPath = request.provider === "local" ? await resolveSelectedModelPath(request.localModel) : "";

    assertNotCancelled(signal);
    updateJob(jobId, {
      progress: PROGRESS.extractionStart,
      message: `Preparing audio extraction for ${formatTimestamp(range.durationSeconds)} selected range`
    });
    const audioPath = await prepareSegmentAudio(request, range, workDir, jobId, metadata, signal);

    const chunkPlan = buildChunkPlan(range.durationSeconds);
    const totalChunks = Math.max(1, chunkPlan.length);
    const aggregatedSegments: WhisperSegment[] = [];

    for (const chunk of chunkPlan) {
      assertNotCancelled(signal);
      updateJob(jobId, {
        progress: mapProgress((chunk.index / totalChunks) * 100, PROGRESS.transcriptionStart, PROGRESS.transcriptionEnd),
        message: `Transcribing chunk ${chunk.index + 1} of ${totalChunks}`
      });

      const chunkAudio = await createAudioChunk(
        audioPath,
        chunk.index,
        chunk.startSeconds,
        chunk.durationSeconds,
        workDir,
        process.env.FFMPEG_BIN || "ffmpeg",
        signal
      );

      assertNotCancelled(signal);
      const rawSegments =
        request.provider === "openai"
          ? await transcribeWithOpenAI({
              audioPath: chunkAudio.audioPath,
              languageHint: request.languageHint,
              glossary: request.glossary
            })
          : await transcribeWithWhisper({
              audioPath: chunkAudio.audioPath,
              workDir,
              languageHint: request.languageHint,
              glossary: request.glossary,
              config: {
                whisperBin: requiredEnv("WHISPER_CPP_BIN"),
                modelPath: localModelPath,
                modelName: request.localModel,
                speed: request.localSpeed
              },
              signal
            });

      aggregatedSegments.push(
        ...offsetSegmentsToVideoTime(
          rawSegments,
          range.startSeconds + chunk.startSeconds,
          request.convertToTraditional
        )
      );

      const partialResult = buildResult(request, range.durationSeconds, aggregatedSegments, totalChunks, chunk.index + 1, true);

      updateJob(jobId, {
        progress: mapProgress(((chunk.index + 1) / totalChunks) * 100, PROGRESS.transcriptionStart, PROGRESS.transcriptionEnd),
        message: chunk.index + 1 === totalChunks ? "Preparing transcript review" : `Processed chunk ${chunk.index + 1} of ${totalChunks}`,
        result: partialResult
      });
    }

    assertNotCancelled(signal);
    updateJob(jobId, { progress: PROGRESS.review, message: "Finalizing transcript review" });
    const result = buildResult(request, range.durationSeconds, aggregatedSegments, totalChunks, totalChunks, false);

    updateJob(jobId, {
      status: "completed",
      progress: PROGRESS.completed,
      message: "Completed",
      result
    });
  } catch (error) {
    if (signal.aborted || isCancellationError(error)) {
      updateJob(jobId, {
        status: "cancelled",
        progress: 100,
        message: "Cancelled"
      });
      return;
    }

    updateJob(jobId, {
      status: "failed",
      progress: 100,
      message: "Failed",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  } finally {
    setTimeout(() => {
      void rm(workDir, { recursive: true, force: true });
      void cleanupRequestUpload(request);
    }, 1000 * 60 * 5);
    jobLogState.delete(jobId);
  }
}

async function prepareSegmentAudio(
  request: TranscriptionRequest,
  range: ReturnType<typeof validateRange>,
  workDir: string,
  jobId: string,
  metadata: VideoMetadata | undefined,
  signal: AbortSignal
): Promise<string> {
  if (request.sourceType === "upload") {
    return extractLocalMediaSegmentAudio({
      sourcePath: request.uploadFilePath,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds,
      workDir,
      tools: {
        ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg"
      },
      onProgress: (progress) => {
        if (progress.phase === "prepare") {
          updateJob(jobId, {
            progress: PROGRESS.extractionStart,
            message: formatPreparationProgressMessage(progress, "Preparing uploaded media")
          });
          return;
        }

        updateJob(jobId, {
          progress: mapProgress(progress.percent, PROGRESS.extractionStart, PROGRESS.conversionEnd),
          message: formatTimedProgressMessage("Converting uploaded media", progress)
        });
      },
      signal
    });
  }

  if (request.youtubeExtractionMode === "cache-first") {
    try {
      const youtubeMetadata = metadata ?? await getYoutubeVideoMetadata(request.youtubeUrl, process.env.YTDLP_BIN || "yt-dlp");
      return await extractCachedYoutubeSegmentAudio({
        youtubeUrl: request.youtubeUrl,
        metadata: youtubeMetadata,
        cacheDir: getYoutubeCacheRoot(),
        startSeconds: range.startSeconds,
        endSeconds: range.endSeconds,
        workDir,
        tools: {
          ytDlpBin: process.env.YTDLP_BIN || "yt-dlp",
          ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg"
        },
        onProgress: (progress) => {
          if (progress.phase === "prepare") {
            updateJob(jobId, {
              progress: PROGRESS.extractionStart,
              message: formatPreparationProgressMessage(progress)
            });
            return;
          }

          if (progress.phase === "download") {
            updateJob(jobId, {
              progress: mapProgress(progress.percent, PROGRESS.extractionStart, PROGRESS.downloadEnd),
              message: formatTimedProgressMessage(progress.detail ?? "Downloading source audio", progress)
            });
            return;
          }

          updateJob(jobId, {
            progress: mapProgress(progress.percent, PROGRESS.downloadEnd, PROGRESS.conversionEnd),
            message: formatTimedProgressMessage("Cutting selected range from cached audio", progress)
          });
        },
        signal
      });
    } catch (error) {
      if (signal.aborted || isCancellationError(error)) {
        throw error;
      }

      const reason = error instanceof Error ? error.message : "Unknown cache error";
      updateJob(jobId, {
        progress: PROGRESS.extractionStart,
        message: `YouTube cache failed; falling back to direct segment extraction - ${reason}`
      });
    }
  }

  return extractSegmentAudio({
    youtubeUrl: request.youtubeUrl,
    startSeconds: range.startSeconds,
    endSeconds: range.endSeconds,
    workDir,
    tools: {
      ytDlpBin: process.env.YTDLP_BIN || "yt-dlp",
      ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg"
    },
    onProgress: (progress) => {
      if (progress.phase === "prepare") {
        updateJob(jobId, {
          progress: PROGRESS.extractionStart,
          message: formatPreparationProgressMessage(progress)
        });
        return;
      }

      if (progress.phase === "download") {
        updateJob(jobId, {
          progress: mapProgress(progress.percent, PROGRESS.extractionStart, PROGRESS.downloadEnd),
          message: formatTimedProgressMessage("Extracting selected audio", progress)
        });
        return;
      }

      updateJob(jobId, {
        progress: mapProgress(progress.percent, PROGRESS.downloadEnd, PROGRESS.conversionEnd),
        message: formatTimedProgressMessage("Converting audio", progress)
      });
    },
    signal
  });
}

function updateJob(jobId: string, patch: Partial<JobRecord>) {
  const current = jobs.get(jobId);
  if (!current) {
    return;
  }

  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };

  jobs.set(jobId, next);
  logJobProgress(next);
}

function mapProgress(percent: number, start: number, end: number): number {
  const safe = Math.max(0, Math.min(100, percent));
  return Number((start + (safe / 100) * (end - start)).toFixed(1));
}

function formatPercent(percent: number): string {
  return `${Math.max(0, Math.min(100, percent)).toFixed(1)}%`;
}

function formatTimedProgressMessage(
  label: string,
  progress: {
    percent: number;
    processedSeconds: number;
    totalSeconds: number;
    remainingSeconds: number;
  }
): string {
  return `${label} ${formatTimestamp(progress.processedSeconds)} / ${formatTimestamp(progress.totalSeconds)} (${formatTimestamp(progress.remainingSeconds)} remaining, ${formatPercent(progress.percent)})`;
}

function formatPreparationProgressMessage(progress: {
  totalSeconds: number;
  detail?: string;
}, label = "Preparing audio extraction"): string {
  const detail = progress.detail ? ` - ${progress.detail}` : "";
  return `${label} for ${formatTimestamp(progress.totalSeconds)} selected range${detail}`;
}

function logJobProgress(job: JobRecord) {
  const previous = jobLogState.get(job.id);
  const progressChanged = !previous || Math.abs(job.progress - previous.progress) >= 1;
  const stage = normalizeProgressStage(job.message);
  const stageChanged = previous?.stage !== stage;
  const terminalStateChanged = job.status === "completed" || job.status === "failed" || job.status === "cancelled";

  if (!progressChanged && !stageChanged && !terminalStateChanged) {
    return;
  }

  jobLogState.set(job.id, {
    progress: job.progress,
    stage
  });

  const shortId = job.id.slice(0, 8);
  const progress = job.progress.toFixed(1).padStart(5, " ");
  console.log(`[job ${shortId}] ${progress}% ${job.message}`);
}

function normalizeProgressStage(message: string): string {
  if (message.startsWith("Extracting selected audio")) {
    return "Extracting selected audio";
  }

  if (message.startsWith("Preparing audio extraction")) {
    return message;
  }

  if (message.startsWith("Converting audio")) {
    return "Converting audio";
  }

  return message.replace(/\s+\d{1,3}(?:\.\d+)?%$/, "");
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for local transcription mode.`);
  }
  return value;
}

function assertNotCancelled(signal: AbortSignal) {
  if (signal.aborted) {
    throw new Error("Job cancelled.");
  }
}

function isCancellationError(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes("cancel");
}

async function cleanupRequestUpload(request: TranscriptionRequest) {
  if (request.sourceType === "upload") {
    await rm(path.dirname(request.uploadFilePath), { recursive: true, force: true });
  }
}

function buildResult(
  request: TranscriptionRequest,
  durationSeconds: number,
  segments: WhisperSegment[],
  totalChunks: number,
  completedChunks: number,
  partial: boolean
): TranscriptionResult {
  const diarizedSentences = applyHeuristicSpeakerDiarization(segmentsToSentences(segments, request.languageHint));
  const sentences = applyQualityHighlights(diarizedSentences, segments);

  return {
    sourceUsed: "audio-transcription",
    provider: request.provider,
    model: request.provider === "openai" ? "gpt-4o-transcribe" : request.localModel,
    durationSeconds,
    sentences,
    partial,
    completedChunks,
    totalChunks
  };
}

function offsetSegmentsToVideoTime(
  segments: WhisperSegment[],
  startSeconds: number,
  convertToTraditional = true
): WhisperSegment[] {
  return segments.map((segment) => ({
    ...segment,
    start: segment.start + startSeconds,
    end: segment.end + startSeconds,
    text: convertToTraditional ? convertBasicSimplifiedToTraditional(segment.text) : segment.text
  }));
}
