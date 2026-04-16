import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { JobRecord, TranscriptionRequest, TranscriptionResult, WhisperSegment } from "../../shared/types.js";
import { applyHeuristicSpeakerDiarization } from "../lib/diarization.js";
import { applyQualityHighlights } from "../lib/quality.js";
import { segmentsToSentences } from "../lib/sentence.js";
import { validateRange } from "../lib/time.js";
import { convertBasicSimplifiedToTraditional } from "../lib/traditional.js";
import { buildChunkPlan, createAudioChunk, extractSegmentAudio } from "./audio.js";
import { transcribeWithOpenAI } from "./openaiTranscription.js";
import { transcribeWithWhisper } from "./whisper.js";

const jobs = new Map<string, JobRecord>();

export function createJob(request: TranscriptionRequest): JobRecord {
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
  void runJob(job.id, request);

  return job;
}

export function getJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

async function runJob(jobId: string, request: TranscriptionRequest) {
  const workDir = await mkdtemp(path.join(os.tmpdir(), "yt-transcribe-"));

  try {
    updateJob(jobId, { status: "running", progress: 5, message: "Validating time range" });
    const range = validateRange(request.startTime, request.endTime);

    updateJob(jobId, { progress: 15, message: "Extracting selected YouTube audio" });
    const audioPath = await extractSegmentAudio({
      youtubeUrl: request.youtubeUrl,
      startSeconds: range.startSeconds,
      endSeconds: range.endSeconds,
      workDir,
      tools: {
        ytDlpBin: process.env.YTDLP_BIN || "yt-dlp",
        ffmpegBin: process.env.FFMPEG_BIN || "ffmpeg"
      }
    });

    const chunkPlan = buildChunkPlan(range.durationSeconds);
    const totalChunks = Math.max(1, chunkPlan.length);
    const aggregatedSegments: WhisperSegment[] = [];

    for (const chunk of chunkPlan) {
      updateJob(jobId, {
        progress: 20 + Math.round((chunk.index / totalChunks) * 60),
        message: `Transcribing chunk ${chunk.index + 1} of ${totalChunks}`
      });

      const chunkAudio = await createAudioChunk(
        audioPath,
        chunk.index,
        chunk.startSeconds,
        chunk.durationSeconds,
        workDir,
        process.env.FFMPEG_BIN || "ffmpeg"
      );

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
                modelPath: requiredEnv("WHISPER_MODEL_PATH"),
                modelName: request.localModel,
                speed: request.localSpeed
              }
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
        progress: 20 + Math.round(((chunk.index + 1) / totalChunks) * 60),
        message: chunk.index + 1 === totalChunks ? "Preparing transcript review" : `Processed chunk ${chunk.index + 1} of ${totalChunks}`,
        result: partialResult
      });
    }

    const result = buildResult(request, range.durationSeconds, aggregatedSegments, totalChunks, totalChunks, false);

    updateJob(jobId, {
      status: "completed",
      progress: 100,
      message: "Completed",
      result
    });
  } catch (error) {
    updateJob(jobId, {
      status: "failed",
      progress: 100,
      message: "Failed",
      error: error instanceof Error ? error.message : "Unknown error"
    });
  } finally {
    setTimeout(() => {
      void rm(workDir, { recursive: true, force: true });
    }, 1000 * 60 * 5);
  }
}

function updateJob(jobId: string, patch: Partial<JobRecord>) {
  const current = jobs.get(jobId);
  if (!current) {
    return;
  }

  jobs.set(jobId, {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  });
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required for local transcription mode.`);
  }
  return value;
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
