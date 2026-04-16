import { useEffect, useMemo, useState } from "react";
import type { JobRecord, LanguageHint, LocalModel, Provider, TranscriptionResult } from "../shared/types";
import { TranscriptView } from "./components/TranscriptView";

const initialForm = {
  youtubeUrl: "",
  startTime: "00:00:00",
  endTime: "00:01:00",
  languageHint: "auto" as LanguageHint,
  provider: "local" as Provider,
  localModel: "large-v3-turbo-q8_0" as LocalModel,
  glossary: "",
  convertToTraditional: true
};

interface LocalSettings {
  defaultLanguage: LanguageHint;
  defaultModel: LocalModel;
}

type ResultView = "transcript" | "plain";

const defaultLocalSettings: LocalSettings = {
  defaultLanguage: "auto",
  defaultModel: "large-v3-turbo-q8_0"
};

export function App() {
  const [settings, setSettings] = useState<LocalSettings>(() => loadLocalSettings());
  const [form, setForm] = useState(() => ({
    ...initialForm,
    languageHint: settings.defaultLanguage,
    localModel: settings.defaultModel
  }));
  const [job, setJob] = useState<JobRecord | null>(null);
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [health, setHealth] = useState<{ localConfigured: boolean; openaiConfigured: boolean } | null>(null);
  const [error, setError] = useState("");
  const [displayedProgress, setDisplayedProgress] = useState(0);
  const [elapsedNow, setElapsedNow] = useState(Date.now());
  const [plainTranscript, setPlainTranscript] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [resultView, setResultView] = useState<ResultView>("transcript");

  const isWorking = job?.status === "queued" || job?.status === "running";
  const progressLabel = displayedProgress.toFixed(1);
  const elapsedLabel = job ? formatElapsedTime(job.createdAt, job.status === "completed" || job.status === "failed" ? job.updatedAt : elapsedNow) : "";
  const reviewCount = useMemo(
    () => result?.sentences.filter((sentence) => sentence.qualityStatus === "review").length ?? 0,
    [result]
  );

  useEffect(() => {
    fetch("/api/health")
      .then((response) => response.json())
      .then(setHealth)
      .catch(() => setHealth(null));
  }, []);

  useEffect(() => {
    localStorage.setItem("yt-transcriber-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    if (!result) {
      setPlainTranscript("");
      return;
    }

    setPlainTranscript(result.sentences.map((sentence) => sentence.text).join("\n\n"));
  }, [result]);

  useEffect(() => {
    if (!job || job.status === "completed" || job.status === "failed") {
      return;
    }

    const id = window.setInterval(async () => {
      const response = await fetch(`/api/transcriptions/${job.id}`);
      const nextJob = (await response.json()) as JobRecord;
      setJob(nextJob);

      if (nextJob.status === "completed") {
        const resultResponse = await fetch(`/api/transcriptions/${job.id}/result`);
        setResult((await resultResponse.json()) as TranscriptionResult);
      }
    }, 1200);

    return () => window.clearInterval(id);
  }, [job]);

  useEffect(() => {
    if (!job) {
      setDisplayedProgress(0);
      return;
    }

    const target = Math.max(0, Math.min(100, job.progress));

    setDisplayedProgress((current) => {
      if (current > target || job.status === "queued") {
        return target;
      }

      return current;
    });

    const id = window.setInterval(() => {
      setDisplayedProgress((current) => {
        if (current >= target) {
          return current;
        }

        return Math.min(target, Number((current + 0.1).toFixed(1)));
      });
    }, 16);

    return () => window.clearInterval(id);
  }, [job?.id, job?.progress, job?.status]);

  useEffect(() => {
    if (!isWorking) {
      return;
    }

    const id = window.setInterval(() => {
      setElapsedNow(Date.now());
    }, 500);

    return () => window.clearInterval(id);
  }, [isWorking]);

  async function submit() {
    setError("");
    setResult(null);
    setCopyStatus("");
    setResultView("transcript");
    setDisplayedProgress(0);
    setElapsedNow(Date.now());

    const response = await fetch("/api/transcriptions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(form)
    });

    const payload = await response.json();
    if (!response.ok) {
      setError(payload.error ?? "Unable to start transcription.");
      return;
    }

    setJob(payload as JobRecord);
  }

  function exportResult(format: "json" | "txt" | "srt") {
    if (!job || !result) {
      return;
    }

    if (format === "json") {
      downloadFile("transcript.json", JSON.stringify(result, null, 2), "application/json");
      return;
    }

    window.open(`/api/transcriptions/${job.id}/result?format=${format}`, "_blank");
  }

  function updateDefaultLanguage(defaultLanguage: LanguageHint) {
    setSettings((current) => ({ ...current, defaultLanguage }));
    setForm((current) => ({ ...current, languageHint: defaultLanguage }));
  }

  function updateDefaultModel(defaultModel: LocalModel) {
    setSettings((current) => ({ ...current, defaultModel }));
    setForm((current) => ({ ...current, localModel: defaultModel }));
  }

  async function copyPlainTranscript() {
    if (!plainTranscript.trim()) {
      return;
    }

    await navigator.clipboard.writeText(plainTranscript);
    setCopyStatus("Copied");
    window.setTimeout(() => setCopyStatus(""), 1500);
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <aside className="control-panel" aria-label="Transcription controls">
          <div className="brand-block">
            <p className="eyebrow">Local audio transcription</p>
            <h1>YouTube Segment Transcriber</h1>
            <p className="subtle">Audio-first, subtitle-free, multilingual transcript review.</p>
          </div>

          <label>
            YouTube URL
            <input
              value={form.youtubeUrl}
              onChange={(event) => setForm({ ...form, youtubeUrl: event.target.value })}
              placeholder="https://www.youtube.com/watch?v=..."
            />
          </label>

          <div className="time-grid">
            <label>
              Start
              <input
                inputMode="numeric"
                value={form.startTime}
                onChange={(event) => setForm({ ...form, startTime: formatTimeInput(event.target.value) })}
              />
            </label>
            <label>
              End
              <input
                inputMode="numeric"
                value={form.endTime}
                onChange={(event) => setForm({ ...form, endTime: formatTimeInput(event.target.value) })}
              />
            </label>
          </div>

          <label>
            Language
            <select
              value={form.languageHint}
              onChange={(event) => setForm({ ...form, languageHint: event.target.value as LanguageHint })}
            >
              <option value="auto">Auto / mixed</option>
              <option value="en">English</option>
              <option value="zh-TW">Chinese Taiwan</option>
              <option value="id">Indonesian</option>
            </select>
          </label>

          <div className="segmented" role="tablist" aria-label="Provider">
            <button
              className={form.provider === "local" ? "active" : ""}
              type="button"
              onClick={() => setForm({ ...form, provider: "local" })}
            >
              Local
            </button>
            <button
              className={form.provider === "openai" ? "active" : ""}
              type="button"
              onClick={() => setForm({ ...form, provider: "openai" })}
              disabled={health?.openaiConfigured === false}
              title={health?.openaiConfigured === false ? "Set OPENAI_API_KEY to enable this mode." : "Use OpenAI API"}
            >
              OpenAI
            </button>
          </div>

          <label>
            Local model
            <select
              value={form.localModel}
              onChange={(event) => setForm({ ...form, localModel: event.target.value as LocalModel })}
              disabled={form.provider !== "local"}
            >
              <option value="large-v3-turbo-q8_0">large-v3-turbo-q8_0 - 834 MiB</option>
              <option value="large-v3-turbo-q5_0">large-v3-turbo-q5_0 - 547 MiB</option>
              <option value="large-v3">large-v3 - 2.9 GiB</option>
            </select>
          </label>

          <label>
            Glossary
            <textarea
              value={form.glossary}
              onChange={(event) => setForm({ ...form, glossary: event.target.value })}
              placeholder="Names, technical terms, brands, slang..."
            />
          </label>

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.convertToTraditional}
              onChange={(event) => setForm({ ...form, convertToTraditional: event.target.checked })}
            />
            Prefer Traditional Chinese cleanup
          </label>

          <section className="local-settings" aria-label="Local settings">
            <div>
              <p className="eyebrow">Local Settings</p>
              <h2>Defaults</h2>
            </div>
            <label>
              Default language
              <select
                value={settings.defaultLanguage}
                onChange={(event) => updateDefaultLanguage(event.target.value as LanguageHint)}
              >
                <option value="auto">Auto / mixed</option>
                <option value="en">English</option>
                <option value="zh-TW">Chinese Taiwan</option>
                <option value="id">Indonesian</option>
              </select>
            </label>
            <label>
              Default model
              <select
                value={settings.defaultModel}
                onChange={(event) => updateDefaultModel(event.target.value as LocalModel)}
              >
                <option value="large-v3-turbo-q8_0">large-v3-turbo-q8_0 - 834 MiB</option>
                <option value="large-v3-turbo-q5_0">large-v3-turbo-q5_0 - 547 MiB</option>
                <option value="large-v3">large-v3 - 2.9 GiB</option>
              </select>
            </label>
          </section>

          {health && !health.localConfigured && form.provider === "local" ? (
            <p className="warning">Set WHISPER_CPP_BIN and WHISPER_MODEL_PATH in `.env` before running local mode.</p>
          ) : null}

          {error ? <p className="error">{error}</p> : null}
          {job?.status === "failed" ? <p className="error">{job.error}</p> : null}

          <button className="primary" type="button" onClick={submit} disabled={isWorking}>
            {isWorking ? "Transcribing..." : "Transcribe Segment"}
          </button>
        </aside>

        <section className="result-panel" aria-label="Transcript result">
          {job ? (
            <div className="status-bar">
              <span>{job.message}</span>
              <span className="elapsed-time">Elapsed {elapsedLabel}</span>
              <progress max="100" value={displayedProgress} />
              <span>{progressLabel}%</span>
            </div>
          ) : null}

          {result ? (
            <>
              <div className="result-header">
                <div>
                  <p className="eyebrow">Transcript</p>
                  <h2>{result.sentences.length} sentences</h2>
                  <p className="subtle">
                    {result.provider} - {result.model} - {reviewCount} need review
                  </p>
                </div>
                <div className="export-actions">
                  <button type="button" onClick={() => exportResult("txt")}>TXT</button>
                  <button type="button" onClick={() => exportResult("srt")}>SRT</button>
                  <button type="button" onClick={() => exportResult("json")}>JSON</button>
                </div>
              </div>
              <div className="segmented result-tabs" role="tablist" aria-label="Result views">
                <button
                  className={resultView === "transcript" ? "active" : ""}
                  type="button"
                  onClick={() => setResultView("transcript")}
                >
                  Transcript
                </button>
                <button
                  className={resultView === "plain" ? "active" : ""}
                  type="button"
                  onClick={() => setResultView("plain")}
                >
                  Editable Paragraph
                </button>
              </div>
              {resultView === "transcript" ? (
                <TranscriptView sentences={result.sentences} />
              ) : (
                <section className="plain-transcript" aria-label="Editable plain transcript">
                  <div className="plain-transcript-header">
                    <div>
                      <p className="eyebrow">Plain Text</p>
                      <h3>Editable paragraph transcript</h3>
                    </div>
                    <button type="button" onClick={copyPlainTranscript}>
                      {copyStatus || "Copy"}
                    </button>
                  </div>
                  <textarea
                    value={plainTranscript}
                    onChange={(event) => setPlainTranscript(event.target.value)}
                    spellCheck="false"
                  />
                </section>
              )}
            </>
          ) : (
            <EmptyState />
          )}
        </section>
      </section>
    </main>
  );
}

function EmptyState() {
  return (
    <div className="empty-state">
      <p className="eyebrow">Ready</p>
      <h2>Choose a video range and transcribe from audio.</h2>
      <p>Results appear here with timestamps, sentence boundaries, and highlighted questionable spans.</p>
    </div>
  );
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  URL.revokeObjectURL(url);
}

function formatTimeInput(value: string): string {
  const digits = value.replace(/\D/g, "").slice(0, 6);

  if (digits.length <= 2) {
    return digits;
  }

  if (digits.length <= 4) {
    return `${digits.slice(0, -2)}:${digits.slice(-2)}`;
  }

  return `${digits.slice(0, -4)}:${digits.slice(-4, -2)}:${digits.slice(-2)}`;
}

function loadLocalSettings(): LocalSettings {
  try {
    const raw = localStorage.getItem("yt-transcriber-settings");
    if (!raw) {
      return defaultLocalSettings;
    }

    const parsed = JSON.parse(raw) as Partial<LocalSettings>;

    return {
      defaultLanguage: isLanguageHint(parsed.defaultLanguage) ? parsed.defaultLanguage : defaultLocalSettings.defaultLanguage,
      defaultModel: isLocalModel(parsed.defaultModel) ? parsed.defaultModel : defaultLocalSettings.defaultModel
    };
  } catch {
    return defaultLocalSettings;
  }
}

function isLanguageHint(value: unknown): value is LanguageHint {
  return value === "auto" || value === "en" || value === "zh-TW" || value === "id";
}

function isLocalModel(value: unknown): value is LocalModel {
  return value === "large-v3-turbo-q8_0" || value === "large-v3-turbo-q5_0" || value === "large-v3";
}

function formatElapsedTime(startValue: string, endValue: string | number): string {
  const start = new Date(startValue).getTime();
  const end = typeof endValue === "number" ? endValue : new Date(endValue).getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) {
    return "00:00";
  }

  const totalSeconds = Math.floor((end - start) / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;

  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
