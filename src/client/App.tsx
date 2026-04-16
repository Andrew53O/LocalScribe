import { useEffect, useMemo, useRef, useState } from "react";
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

interface VideoMetadata {
  id?: string;
  durationSeconds: number;
  title?: string;
}

interface PlayerState {
  embedUrl: string;
  videoId: string;
}

interface LocalPrerequisite {
  key: "ytDlp" | "ffmpeg" | "whisperBin" | "whisperModel";
  label: string;
  ok: boolean;
  path?: string;
  error?: string;
}

interface HealthStatus {
  localConfigured: boolean;
  localPrerequisites: LocalPrerequisite[];
  openaiConfigured: boolean;
}

type ReviewState = "pending" | "approved" | "needs-review" | "edited";
type ReviewFilter = "all" | ReviewState;

interface ReviewDraft {
  text: string;
  reviewState: ReviewState;
  note: string;
}

interface HistoryItem {
  youtubeUrl: string;
  title: string;
  thumbnailUrl: string;
  durationSeconds?: number;
  savedAt: string;
}

type ControlView = "transcribe" | "history";

const defaultLocalSettings: LocalSettings = {
  defaultLanguage: "auto",
  defaultModel: "large-v3-turbo-q8_0"
};

export function App() {
  const resultPanelRef = useRef<HTMLElement | null>(null);
  const [settings, setSettings] = useState<LocalSettings>(() => loadLocalSettings());
  const [form, setForm] = useState(() => ({
    ...initialForm,
    languageHint: settings.defaultLanguage,
    localModel: settings.defaultModel
  }));
  const [job, setJob] = useState<JobRecord | null>(null);
  const [result, setResult] = useState<TranscriptionResult | null>(null);
  const [health, setHealth] = useState<HealthStatus | null>(null);
  const [error, setError] = useState("");
  const [displayedProgress, setDisplayedProgress] = useState(0);
  const [elapsedNow, setElapsedNow] = useState(Date.now());
  const [plainTranscript, setPlainTranscript] = useState("");
  const [copyStatus, setCopyStatus] = useState("");
  const [resultView, setResultView] = useState<ResultView>("transcript");
  const [videoMetadata, setVideoMetadata] = useState<VideoMetadata | null>(null);
  const [metadataStatus, setMetadataStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [metadataError, setMetadataError] = useState("");
  const [activeSentenceIndex, setActiveSentenceIndex] = useState<number | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<ReviewDraft[]>([]);
  const [reviewFilter, setReviewFilter] = useState<ReviewFilter>("all");
  const [editingSentenceIndex, setEditingSentenceIndex] = useState<number | null>(null);
  const [controlView, setControlView] = useState<ControlView>("transcribe");
  const [showSettings, setShowSettings] = useState(false);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>(() => loadHistoryItems());
  const [historyQuery, setHistoryQuery] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const isWorking = job?.status === "queued" || job?.status === "running";
  const progressLabel = displayedProgress.toFixed(1);
  const elapsedLabel = job ? formatElapsedTime(job.createdAt, job.status === "completed" || job.status === "failed" ? job.updatedAt : elapsedNow) : "";
  const timeRangeError = getTimeRangeError(form.startTime, form.endTime, videoMetadata?.durationSeconds);
  const reviewCount = useMemo(
    () => result?.sentences.filter((sentence) => sentence.qualityStatus === "review").length ?? 0,
    [result]
  );
  const playerState = useMemo(() => createPlayerState(form.youtubeUrl), [form.youtubeUrl]);
  const transcriptSentences = useMemo(() => {
    if (!result) {
      return [];
    }

    return result.sentences.map((sentence, index) => {
      const draft = reviewDrafts[index];
      const reviewState = draft?.reviewState ?? (sentence.qualityStatus === "review" ? "needs-review" : "pending");

      return {
        ...sentence,
        text: draft?.text ?? sentence.text,
        qualityStatus: reviewState === "needs-review" ? "review" : "ok"
      };
    });
  }, [result, reviewDrafts]);
  const visibleSentenceIndices = useMemo(
    () =>
      transcriptSentences
        .map((sentence, index) => ({ sentence, index }))
        .filter(({ index }) => reviewFilter === "all" || reviewDrafts[index]?.reviewState === reviewFilter)
        .map(({ index }) => index),
    [transcriptSentences, reviewDrafts, reviewFilter]
  );
  const reviewSummary = useMemo(
    () => ({
      pending: reviewDrafts.filter((draft) => draft.reviewState === "pending").length,
      approved: reviewDrafts.filter((draft) => draft.reviewState === "approved").length,
      needsReview: reviewDrafts.filter((draft) => draft.reviewState === "needs-review").length,
      edited: reviewDrafts.filter((draft) => draft.reviewState === "edited").length
    }),
    [reviewDrafts]
  );
  const filteredHistoryItems = useMemo(() => {
    const query = historyQuery.trim().toLowerCase();

    if (!query) {
      return historyItems;
    }

    return historyItems.filter(
      (item) => item.title.toLowerCase().includes(query) || item.youtubeUrl.toLowerCase().includes(query)
    );
  }, [historyItems, historyQuery]);

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
    localStorage.setItem("yt-transcriber-history", JSON.stringify(historyItems));
  }, [historyItems]);

  useEffect(() => {
    if (!result) {
      setPlainTranscript("");
      setActiveSentenceIndex(null);
      setReviewDrafts([]);
      setReviewFilter("all");
      setEditingSentenceIndex(null);
      return;
    }

    setPlainTranscript(result.sentences.map((sentence) => sentence.text).join("\n\n"));
    setActiveSentenceIndex(0);
    setReviewDrafts(
      result.sentences.map((sentence) => ({
        text: sentence.text,
        reviewState: sentence.qualityStatus === "review" ? "needs-review" : "pending",
        note: ""
      }))
    );
  }, [result]);

  useEffect(() => {
    if (!result || !form.youtubeUrl.trim()) {
      return;
    }

    const historyItem = createHistoryItem(form.youtubeUrl, videoMetadata);

    setHistoryItems((current) => {
      const next = [
        historyItem,
        ...current.filter((item) => item.youtubeUrl !== historyItem.youtubeUrl)
      ];

      return next.slice(0, 30);
    });
  }, [result, form.youtubeUrl, videoMetadata]);

  useEffect(() => {
    const youtubeUrl = form.youtubeUrl.trim();

    if (!youtubeUrl) {
      setVideoMetadata(null);
      setMetadataStatus("idle");
      setMetadataError("");
      return;
    }

    let cancelled = false;
    setMetadataStatus("loading");
    setMetadataError("");

    const timeoutId = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/video-metadata?youtubeUrl=${encodeURIComponent(youtubeUrl)}`);
        const payload = await response.json();

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setVideoMetadata(null);
          setMetadataStatus("error");
          setMetadataError(payload.error ?? "Unable to fetch video duration.");
          return;
        }

        setVideoMetadata(payload as VideoMetadata);
        setMetadataStatus("ready");
      } catch {
        if (cancelled) {
          return;
        }

        setVideoMetadata(null);
        setMetadataStatus("error");
        setMetadataError("Unable to fetch video duration.");
      }
    }, 450);

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
  }, [form.youtubeUrl]);

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
    setControlView("transcribe");
    setDisplayedProgress(0);
    setElapsedNow(Date.now());
    setEditingSentenceIndex(null);

    if (timeRangeError) {
      setError(timeRangeError);
      return;
    }

    setIsSubmitting(true);

    try {
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
    } finally {
      setIsSubmitting(false);
    }
  }

  async function exportResult(format: "json" | "txt" | "srt") {
    if (!job || !result) {
      return;
    }

    if (format === "json") {
      downloadFile("transcript.json", JSON.stringify(result, null, 2), "application/json");
      return;
    }

    const response = await fetch(`/api/transcriptions/${job.id}/result?format=${format}`);
    const content = await response.text();

    if (!response.ok) {
      setError("Unable to download transcript.");
      return;
    }

    const contentType = response.headers.get("content-type") ?? "text/plain; charset=utf-8";
    downloadFile(`transcript.${format}`, content, contentType);
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

  function setSentenceReviewState(index: number, reviewState: ReviewState) {
    setReviewDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index
          ? {
              ...draft,
              reviewState
            }
          : draft
      )
    );
  }

  function updateSentenceText(index: number, text: string) {
    setReviewDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index
          ? {
              ...draft,
              text,
              reviewState: "edited"
            }
          : draft
      )
    );
  }

  function resetSentenceText(index: number) {
    if (!result) {
      return;
    }

    setReviewDrafts((current) =>
      current.map((draft, draftIndex) =>
        draftIndex === index
          ? {
              ...draft,
              text: result.sentences[index].text,
              reviewState: result.sentences[index].qualityStatus === "review" ? "needs-review" : "pending"
            }
          : draft
      )
    );
    setEditingSentenceIndex(null);
  }

  function seekToSentence(seconds: number, index: number) {
    setActiveSentenceIndex(index);

    if (!playerState) {
      return;
    }

    const iframe = document.getElementById("youtube-player-frame") as HTMLIFrameElement | null;
    if (!iframe?.contentWindow) {
      return;
    }

    iframe.contentWindow.postMessage(
      JSON.stringify({
        event: "command",
        func: "seekTo",
        args: [Math.max(0, Math.floor(seconds)), true]
      }),
      "*"
    );

    iframe.contentWindow.postMessage(
      JSON.stringify({
        event: "command",
        func: "playVideo",
        args: []
      }),
      "*"
    );
  }

  function scrollSentenceIntoView(index: number) {
    const row = resultPanelRef.current?.querySelector<HTMLElement>(`[data-sentence-index="${index}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function jumpToActiveSentence() {
    if (!result || activeSentenceIndex === null) {
      return;
    }

    seekToSentence(result.sentences[activeSentenceIndex].startSeconds, activeSentenceIndex);
    window.setTimeout(() => scrollSentenceIntoView(activeSentenceIndex), 120);
  }

  function restoreHistoryItem(item: HistoryItem) {
    setForm((current) => ({
      ...current,
      youtubeUrl: item.youtubeUrl
    }));
    setControlView("transcribe");
  }

  return (
    <main className="app-shell">
      <section className="workspace">
        <aside className="control-panel" aria-label="Transcription controls">
          <div className="control-header">
            <div className="segmented control-tabs" role="tablist" aria-label="Control views">
              <button className={controlView === "transcribe" ? "active" : ""} type="button" onClick={() => setControlView("transcribe")}>
                Transcribe
              </button>
              <button className={controlView === "history" ? "active" : ""} type="button" onClick={() => setControlView("history")}>
                History
              </button>
            </div>
            <button
              className={`icon-button settings-toggle ${showSettings ? "active" : ""}`}
              type="button"
              aria-label="Open local settings"
              title="Local settings"
              onClick={() => setShowSettings((current) => !current)}
            >
              ≡
            </button>
          </div>
          <div className="brand-block">
            <p className="eyebrow">Local audio transcription</p>
            <h1>YouTube Segment Transcriber</h1>
            <p className="subtle">Audio-first, subtitle-free, multilingual transcript review.</p>
          </div>
          {showSettings ? (
            <section className="settings-drawer" aria-label="Local settings">
              <div className="settings-drawer-header">
                <div>
                  <p className="eyebrow">Local Settings</p>
                  <h2>Defaults</h2>
                </div>
                <button
                  className="icon-button"
                  type="button"
                  aria-label="Close local settings"
                  title="Close settings"
                  onClick={() => setShowSettings(false)}
                >
                  ×
                </button>
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
          ) : null}

          {controlView === "history" ? (
            <section className="history-panel" aria-label="History">
              <label>
                Search history
                <input
                  value={historyQuery}
                  onChange={(event) => setHistoryQuery(event.target.value)}
                  placeholder="Search title or URL"
                />
              </label>

              <div className="history-list">
                {filteredHistoryItems.length > 0 ? (
                  filteredHistoryItems.map((item) => (
                    <button className="history-item" key={`${item.youtubeUrl}-${item.savedAt}`} type="button" onClick={() => restoreHistoryItem(item)}>
                      <img alt="" src={item.thumbnailUrl} loading="lazy" />
                      <div className="history-item-body">
                        <strong>{item.title}</strong>
                        <span>{item.youtubeUrl}</span>
                        <div className="history-item-meta">
                          <span>{item.durationSeconds ? formatDuration(item.durationSeconds) : "Unknown length"}</span>
                          <span>{formatSavedAt(item.savedAt)}</span>
                        </div>
                      </div>
                    </button>
                  ))
                ) : (
                  <div className="empty-history">
                    <p className="eyebrow">History</p>
                    <h2>No saved videos yet</h2>
                    <p>Completed transcriptions are saved locally with thumbnail, title, and link.</p>
                  </div>
                )}
              </div>
            </section>
          ) : (
            <>

          <label>
            YouTube URL
            <input
              value={form.youtubeUrl}
              onChange={(event) => setForm({ ...form, youtubeUrl: event.target.value })}
              placeholder="https://www.youtube.com/watch?v=..."
            />
          </label>

          {metadataStatus === "loading" ? <p className="subtle">Checking video duration...</p> : null}
          {videoMetadata ? (
            <p className="subtle">Video length: {formatDuration(videoMetadata.durationSeconds)}</p>
          ) : null}
          {metadataStatus === "error" ? <p className="warning">{metadataError}</p> : null}

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

          {health && !health.localConfigured && form.provider === "local" ? (
            <div className="warning">
              <p className="warning-title">Local setup is incomplete.</p>
              <ul className="prerequisite-list">
                {health.localPrerequisites
                  .filter((item) => !item.ok)
                  .map((item) => (
                    <li key={item.key}>
                      <strong>{item.label}:</strong> {item.error ?? "Missing"}
                    </li>
                  ))}
              </ul>
            </div>
          ) : null}

          {error ? <p className="error">{error}</p> : null}
          {timeRangeError ? <p className="error">{timeRangeError}</p> : null}
          {job?.status === "failed" ? <p className="error">{job.error}</p> : null}

          <button
            className={`primary ${isSubmitting || isWorking ? "busy" : ""}`}
            type="button"
            onClick={submit}
            disabled={isSubmitting || isWorking || Boolean(timeRangeError)}
            aria-busy={isSubmitting || isWorking}
          >
            {isSubmitting || isWorking ? <span className="button-spinner" aria-hidden="true" /> : null}
            <span>{isSubmitting ? "Starting..." : isWorking ? "Transcribing..." : "Transcribe Segment"}</span>
          </button>
            </>
          )}
        </aside>

        <section className="result-panel" aria-label="Transcript result" ref={resultPanelRef}>
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
              {playerState ? (
                <section className="player-panel" aria-label="YouTube playback">
                  <div className="player-header">
                    <div>
                      <p className="eyebrow">Playback</p>
                      <h3>Synced YouTube player</h3>
                    </div>
                    <button type="button" onClick={jumpToActiveSentence}>
                      Jump to active line
                    </button>
                  </div>
                  <div className="player-frame-wrap">
                    <iframe
                      id="youtube-player-frame"
                      title="YouTube player"
                      src={playerState.embedUrl}
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                    />
                  </div>
                </section>
              ) : null}
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
                <>
                  <section className="review-toolbar" aria-label="Review workflow">
                    <div className="review-summary">
                      <span>Pending {reviewSummary.pending}</span>
                      <span>Needs review {reviewSummary.needsReview}</span>
                      <span>Approved {reviewSummary.approved}</span>
                      <span>Edited {reviewSummary.edited}</span>
                    </div>
                    <div className="segmented review-filters" role="tablist" aria-label="Review filters">
                      <button className={reviewFilter === "all" ? "active" : ""} type="button" onClick={() => setReviewFilter("all")}>
                        All
                      </button>
                      <button
                        className={reviewFilter === "needs-review" ? "active" : ""}
                        type="button"
                        onClick={() => setReviewFilter("needs-review")}
                      >
                        Needs review
                      </button>
                      <button
                        className={reviewFilter === "approved" ? "active" : ""}
                        type="button"
                        onClick={() => setReviewFilter("approved")}
                      >
                        Approved
                      </button>
                      <button className={reviewFilter === "edited" ? "active" : ""} type="button" onClick={() => setReviewFilter("edited")}>
                        Edited
                      </button>
                    </div>
                  </section>
                  <TranscriptView
                  sentences={transcriptSentences}
                  visibleSentenceIndices={visibleSentenceIndices}
                  activeSentenceIndex={activeSentenceIndex ?? undefined}
                  onSeek={seekToSentence}
                  reviewDrafts={reviewDrafts}
                  editingSentenceIndex={editingSentenceIndex}
                  onStartEditing={setEditingSentenceIndex}
                  onStopEditing={() => setEditingSentenceIndex(null)}
                  onReviewStateChange={setSentenceReviewState}
                  onDraftTextChange={updateSentenceText}
                  onResetSentence={resetSentenceText}
                />
                </>
              ) : (
                <section className="plain-transcript" aria-label="Editable plain transcript">
                  <div className="plain-transcript-header">
                    <div>
                      <p className="eyebrow">Plain Text</p>
                      <h3>Editable paragraph transcript</h3>
                    </div>
                    <button
                      className="icon-button copy-button"
                      type="button"
                      onClick={copyPlainTranscript}
                      aria-label={copyStatus || "Copy paragraph transcript"}
                      title={copyStatus || "Copy paragraph transcript"}
                    >
                      <span aria-hidden="true">⧉</span>
                    </button>
                  </div>
                  {copyStatus ? <p className="subtle copy-status">{copyStatus}</p> : null}
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

function parseClientTimestamp(value: string): number | null {
  const trimmed = value.trim();
  const match = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/.exec(trimmed);

  if (!match) {
    return null;
  }

  return (match[1] ? Number(match[1]) : 0) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

function getTimeRangeError(startTime: string, endTime: string, durationSeconds?: number): string {
  const startSeconds = parseClientTimestamp(startTime);
  const endSeconds = parseClientTimestamp(endTime);

  if (startSeconds === null || endSeconds === null) {
    return "";
  }

  if (endSeconds <= startSeconds) {
    return "End time must be after start time.";
  }

  if (durationSeconds !== undefined && (startSeconds > durationSeconds || endSeconds > durationSeconds)) {
    return `Selected range exceeds the video length (${formatDuration(durationSeconds)}).`;
  }

  return "";
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

function formatDuration(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function loadHistoryItems(): HistoryItem[] {
  try {
    const raw = localStorage.getItem("yt-transcriber-history");
    if (!raw) {
      return [];
    }

    const parsed = JSON.parse(raw) as HistoryItem[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function createHistoryItem(youtubeUrl: string, metadata: VideoMetadata | null): HistoryItem {
  const videoId = metadata?.id ?? extractYoutubeVideoId(youtubeUrl) ?? "unknown";

  return {
    youtubeUrl,
    title: metadata?.title?.trim() || youtubeUrl,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: metadata?.durationSeconds,
    savedAt: new Date().toISOString()
  };
}

function formatSavedAt(value: string): string {
  const date = new Date(value);

  if (!Number.isFinite(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}

function createPlayerState(youtubeUrl: string): PlayerState | null {
  const videoId = extractYoutubeVideoId(youtubeUrl);

  if (!videoId) {
    return null;
  }

  return {
    videoId,
    embedUrl: `https://www.youtube.com/embed/${videoId}?enablejsapi=1&playsinline=1&rel=0`
  };
}

function extractYoutubeVideoId(value: string): string | null {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^www\./, "").toLowerCase();

    if (host === "youtu.be") {
      return url.pathname.split("/").filter(Boolean)[0] ?? null;
    }

    if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
      if (url.searchParams.has("v")) {
        return url.searchParams.get("v");
      }

      const segments = url.pathname.split("/").filter(Boolean);
      if ((segments[0] === "shorts" || segments[0] === "live") && segments[1]) {
        return segments[1];
      }
    }

    return null;
  } catch {
    return null;
  }
}
