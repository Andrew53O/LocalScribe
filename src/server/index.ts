import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { createWriteStream } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import Fastify, { type FastifyRequest } from "fastify";
import { loadLocalEnv } from "./lib/env.js";
import { resultToSrt, resultToText } from "./lib/export.js";
import { parseTimestamp } from "./lib/time.js";
import { transcriptionRequestSchema, uploadTranscriptionRequestSchema } from "./lib/validation.js";
import { getYoutubeVideoMetadata } from "./services/audio.js";
import { cancelJob, createJob, getJob } from "./services/jobs.js";
import { getLocalPrerequisiteStatus } from "./services/prerequisites.js";
import { clearYoutubeCache, getYoutubeCacheRoot } from "./services/youtubeCache.js";

await loadLocalEnv();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = Fastify({
  logger: {
    level: process.env.LOG_LEVEL ?? "warn"
  }
});

await app.register(cors, {
  origin: true
});

await app.register(multipart, {
  limits: {
    files: 1,
    fileSize: Number(process.env.UPLOAD_MAX_BYTES || 1024 * 1024 * 1024 * 2)
  }
});

app.get("/api/health", async () => {
  const localStatus = await getLocalPrerequisiteStatus();

  return {
    ok: true,
    localConfigured: localStatus.ok,
    localPrerequisites: localStatus.tools,
    localModelPrerequisites: localStatus.models,
    gpuStatus: localStatus.gpu,
    youtubeCacheDir: getYoutubeCacheRoot(),
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY)
  };
});

app.delete("/api/youtube-cache", async () => {
  const result = await clearYoutubeCache();
  return {
    ok: true,
    ...result
  };
});

app.get("/api/video-metadata", async (request, reply) => {
  const query = request.query as { youtubeUrl?: string };

  if (!query.youtubeUrl) {
    return reply.code(400).send({ error: "youtubeUrl is required." });
  }

  try {
    const metadata = await getYoutubeVideoMetadata(query.youtubeUrl, process.env.YTDLP_BIN || "yt-dlp");
    return metadata;
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Unable to fetch video metadata."
    });
  }
});

app.post("/api/transcriptions", async (request, reply) => {
  if (request.isMultipart()) {
    try {
      const uploadRequest = await parseUploadTranscriptionRequest(request);
      const parsed = uploadTranscriptionRequestSchema.safeParse(uploadRequest);

      if (!parsed.success) {
        await rm(path.dirname(uploadRequest.uploadFilePath), { recursive: true, force: true });
        return reply.code(400).send({
          error: parsed.error.issues.map((issue) => issue.message).join(" ")
        });
      }

      const job = createJob(parsed.data);
      return reply.code(202).send(job);
    } catch (error) {
      return reply.code(400).send({
        error: error instanceof Error ? error.message : "Unable to process uploaded file."
      });
    }
  }

  const parsed = transcriptionRequestSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: parsed.error.issues.map((issue) => issue.message).join(" ")
    });
  }

  let metadata: Awaited<ReturnType<typeof getYoutubeVideoMetadata>>;

  try {
    metadata = await getYoutubeVideoMetadata(parsed.data.youtubeUrl, process.env.YTDLP_BIN || "yt-dlp");
    const startSeconds = parseTimestamp(parsed.data.startTime);
    const endSeconds = parseTimestamp(parsed.data.endTime);

    if (startSeconds > metadata.durationSeconds || endSeconds > metadata.durationSeconds) {
      return reply.code(400).send({
        error: `Selected time range exceeds the video duration (${Math.floor(metadata.durationSeconds)} seconds).`
      });
    }
  } catch (error) {
    return reply.code(400).send({
      error: error instanceof Error ? error.message : "Unable to validate the video duration."
    });
  }

  const job = createJob(parsed.data, metadata);
  return reply.code(202).send(job);
});

async function parseUploadTranscriptionRequest(request: FastifyRequest) {
  const uploadDir = await mkdtemp(path.join(os.tmpdir(), "yt-transcribe-upload-"));
  const fields: Record<string, unknown> = {};
  let uploadFilePath = "";

  try {
    for await (const part of request.parts()) {
      if (part.type === "file") {
        if (uploadFilePath) {
          part.file.resume();
          continue;
        }

        const fileName = sanitizeUploadFileName(part.filename || "uploaded-media");
        uploadFilePath = path.join(uploadDir, `${crypto.randomUUID()}-${fileName}`);
        fields.uploadFileName = fileName;
        fields.uploadMimeType = part.mimetype;
        await pipeline(part.file, createWriteStream(uploadFilePath));
      } else {
        fields[part.fieldname] = part.value;
      }
    }

    if (!uploadFilePath) {
      throw new Error("Choose a local audio or video file to upload.");
    }

    return {
      ...fields,
      sourceType: "upload",
      uploadFilePath
    };
  } catch (error) {
    await rm(uploadDir, { recursive: true, force: true });
    throw error;
  }
}

function sanitizeUploadFileName(value: string): string {
  const safe = path.basename(value).replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").slice(0, 160);
  return safe || "uploaded-media";
}

app.get("/api/transcriptions/:jobId", async (request, reply) => {
  const params = request.params as { jobId: string };
  const job = getJob(params.jobId);

  if (!job) {
    return reply.code(404).send({ error: "Job not found." });
  }

  return job;
});

app.post("/api/transcriptions/:jobId/cancel", async (request, reply) => {
  const params = request.params as { jobId: string };
  const job = cancelJob(params.jobId);

  if (!job) {
    return reply.code(404).send({ error: "Job not found." });
  }

  return job;
});

app.get("/api/transcriptions/:jobId/result", async (request, reply) => {
  const params = request.params as { jobId: string };
  const query = request.query as { format?: string };
  const job = getJob(params.jobId);

  if (!job) {
    return reply.code(404).send({ error: "Job not found." });
  }

  if (job.status !== "completed" || !job.result) {
    return reply.code(409).send({ error: "Job has not completed." });
  }

  if (query.format === "txt") {
    return reply
      .header("content-type", "text/plain; charset=utf-8")
      .header("content-disposition", 'attachment; filename="transcript.txt"')
      .send(resultToText(job.result));
  }

  if (query.format === "srt") {
    return reply
      .header("content-type", "application/x-subrip; charset=utf-8")
      .header("content-disposition", 'attachment; filename="transcript.srt"')
      .send(resultToSrt(job.result));
  }

  return job.result;
});

const clientDist = path.resolve(__dirname, "../client");
let hasClientDist = false;

try {
  await access(path.join(clientDist, "index.html"));
  hasClientDist = true;
  await app.register(staticPlugin, {
    root: clientDist,
    prefix: "/",
    decorateReply: false
  });
} catch {
  hasClientDist = false;
}

app.setNotFoundHandler((request, reply) => {
  if (request.raw.url?.startsWith("/api")) {
    return reply.code(404).send({ error: "API route not found." });
  }

  if (hasClientDist) {
    return reply.sendFile("index.html");
  }

  return reply.code(404).send({ error: "Client build not found. Run npm run build or use npm run dev:client." });
});

const port = Number(process.env.PORT || 8787);
await app.listen({ port, host: "127.0.0.1" });
