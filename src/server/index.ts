import path from "node:path";
import { fileURLToPath } from "node:url";
import { access } from "node:fs/promises";
import cors from "@fastify/cors";
import staticPlugin from "@fastify/static";
import Fastify from "fastify";
import { loadLocalEnv } from "./lib/env.js";
import { resultToSrt, resultToText } from "./lib/export.js";
import { parseTimestamp } from "./lib/time.js";
import { transcriptionRequestSchema } from "./lib/validation.js";
import { getYoutubeVideoMetadata } from "./services/audio.js";
import { createJob, getJob } from "./services/jobs.js";
import { getLocalPrerequisiteStatus } from "./services/prerequisites.js";

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

app.get("/api/health", async () => {
  const localStatus = await getLocalPrerequisiteStatus();

  return {
    ok: true,
    localConfigured: localStatus.ok,
    localPrerequisites: localStatus.tools,
    gpuStatus: localStatus.gpu,
    openaiConfigured: Boolean(process.env.OPENAI_API_KEY)
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
  const parsed = transcriptionRequestSchema.safeParse(request.body);

  if (!parsed.success) {
    return reply.code(400).send({
      error: parsed.error.issues.map((issue) => issue.message).join(" ")
    });
  }

  try {
    const metadata = await getYoutubeVideoMetadata(parsed.data.youtubeUrl, process.env.YTDLP_BIN || "yt-dlp");
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

  const job = createJob(parsed.data);
  return reply.code(202).send(job);
});

app.get("/api/transcriptions/:jobId", async (request, reply) => {
  const params = request.params as { jobId: string };
  const job = getJob(params.jobId);

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
