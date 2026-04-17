import { useEffect, useMemo, useRef, useState } from "react";
import type { ClipboardEvent, FocusEvent, KeyboardEvent, MouseEvent } from "react";
import type { GpuStatus, JobRecord, LanguageHint, LocalModel, LocalSpeedSettings, Provider, TranscriptionResult } from "../shared/types";
import { TranscriptView } from "./components/TranscriptView";

const initialForm = {
  youtubeUrl: "",
  startTime: "00:00:00",
  endTime: "00:01:00",
  languageHint: "auto" as LanguageHint,
  provider: "local" as Provider,
  localModel: "large-v3-turbo-q8_0" as LocalModel,
  glossary: "",
  convertToTraditional: true,
  localSpeed: {
    beamSize: 5,
    bestOf: 5,
    threads: 4,
    vadEnabled: false
  }
};

interface LocalSettings {
  defaultLanguage: LanguageHint;
  defaultModel: LocalModel;
  defaultSpeed: LocalSpeedSettings;
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

interface DebugEntry {
  id: string;
  method: string;
  url: string;
  startedAt: string;
  durationMs: number;
  status?: number;
  requestBody?: string;
  responseBody?: string;
  error?: string;
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
  gpuStatus: GpuStatus;
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
  startTime?: string;
  endTime?: string;
  savedAt: string;
}

type ControlView = "transcribe" | "history" | "debug";
type TimeFieldName = "startTime" | "endTime";

const defaultLocalSettings: LocalSettings = {
  defaultLanguage: "auto",
  defaultModel: "large-v3-turbo-q8_0",
  defaultSpeed: {
    beamSize: 5,
    bestOf: 5,
    threads: 4,
    vadEnabled: false
  }
};

export function App() {
  const resultPanelRef = useRef<HTMLElement | null>(null);
  const playerIframeRef = useRef<HTMLIFrameElement | null>(null);
  const youtubePlayerRef = useRef<YoutubePlayer | null>(null);
  const activeSentenceIndexRef = useRef<number | null>(null);
  const timeFieldStateRef = useRef<Record<TimeFieldName, { segmentIndex: number; firstDigit: string } | null>>({
    startTime: null,
    endTime: null
  });
  const [settings, setSettings] = useState<LocalSettings>(() => loadLocalSettings());
  const [form, setForm] = useState(() => ({
    ...initialForm,
    languageHint: settings.defaultLanguage,
    localModel: settings.defaultModel,
    localSpeed: settings.defaultSpeed
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
  const [playerFocusMode, setPlayerFocusMode] = useState(false);
  const [isControlPanelCollapsed, setIsControlPanelCollapsed] = useState(false);
  const [debugEnabled, setDebugEnabled] = useState(() => localStorage.getItem("yt-transcriber-debug") === "true");
  const [debugEntries, setDebugEntries] = useState<DebugEntry[]>([]);
  const [playerApiStatus, setPlayerApiStatus] = useState<"idle" | "loading" | "ready" | "error">("idle");
  const [playerApiError, setPlayerApiError] = useState("");
  const [iframePlaybackRequest, setIframePlaybackRequest] = useState({ startSeconds: 0, nonce: 0 });

  const isWorking = job?.status === "queued" || job?.status === "running";
  const playerState = useMemo(() => createPlayerState(form.youtubeUrl), [form.youtubeUrl]);
  const isInteractiveMode = playerFocusMode && Boolean(playerState);
  const showCollapsedControlPanel = isInteractiveMode && isControlPanelCollapsed;
  const progressLabel = displayedProgress.toFixed(1);
  const elapsedLabel = job ? formatElapsedTime(job.createdAt, job.status === "completed" || job.status === "failed" ? job.updatedAt : elapsedNow) : "";
  const timeRangeError = getTimeRangeError(form.startTime, form.endTime, videoMetadata?.durationSeconds);
  const reviewCount = useMemo(() => result?.sentences.filter((sentence) => sentence.qualityStatus === "review").length ?? 0, [result]);
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

  const appendDebugEntry = (entry: Omit<DebugEntry, "id">) => {
    setDebugEntries((current) => [
      {
        id: crypto.randomUUID(),
        ...entry
      },
      ...current
    ].slice(0, 80));
  };

  useEffect(() => {
    activeSentenceIndexRef.current = activeSentenceIndex;
  }, [activeSentenceIndex]);

  useEffect(() => {
    let cancelled = false;

    async function refreshHealth() {
      try {
        const { data: payload } = await performTrackedRequest<HealthStatus>({
          url: "/api/health",
          responseType: "json",
          onComplete: appendDebugEntry
        });

        if (!cancelled) {
          setHealth(payload);
        }
      } catch {
        if (!cancelled) {
          setHealth(null);
        }
      }
    }

    void refreshHealth();
    const intervalId = window.setInterval(refreshHealth, isWorking ? 2000 : 5000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [isWorking]);

  useEffect(() => {
    localStorage.setItem("yt-transcriber-settings", JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    localStorage.setItem("yt-transcriber-debug", String(debugEnabled));

    if (!debugEnabled && controlView === "debug") {
      setControlView("transcribe");
    }
  }, [controlView, debugEnabled]);

  useEffect(() => {
    localStorage.setItem("yt-transcriber-history", JSON.stringify(historyItems));
  }, [historyItems]);

  useEffect(() => {
    function handleDebugShortcut(event: globalThis.KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === "d") {
        event.preventDefault();
        setDebugEnabled((current) => !current);
      }
    }

    window.addEventListener("keydown", handleDebugShortcut);
    return () => window.removeEventListener("keydown", handleDebugShortcut);
  }, []);

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
    if (!result || !form.youtubeUrl.trim() || job?.status !== "completed") {
      return;
    }

    const historyItem = createHistoryItem(form.youtubeUrl, videoMetadata, form.startTime, form.endTime);

    setHistoryItems((current) => {
      const next = [
        historyItem,
        ...current.filter(
          (item) =>
            !(
              item.youtubeUrl === historyItem.youtubeUrl &&
              item.startTime === historyItem.startTime &&
              item.endTime === historyItem.endTime
            )
        )
      ];

      return next.slice(0, 30);
    });
  }, [result, form.youtubeUrl, videoMetadata, job?.status]);

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
        const { response, data: payload } = await performTrackedRequest<VideoMetadata | { error?: string }>({
          url: `/api/video-metadata?youtubeUrl=${encodeURIComponent(youtubeUrl)}`,
          responseType: "json",
          onComplete: appendDebugEntry
        });

        if (cancelled) {
          return;
        }

        if (!response.ok) {
          setVideoMetadata(null);
          setMetadataStatus("error");
          setMetadataError("error" in payload ? (payload.error ?? "Unable to fetch video duration.") : "Unable to fetch video duration.");
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
      const { data: nextJob } = await performTrackedRequest<JobRecord>({
        url: `/api/transcriptions/${job.id}`,
        responseType: "json",
        onComplete: appendDebugEntry
      });
      setJob(nextJob);
      if (nextJob.result) {
        setResult(nextJob.result);
      }

      if (nextJob.status === "completed" && !nextJob.result) {
        const { data } = await performTrackedRequest<TranscriptionResult>({
          url: `/api/transcriptions/${job.id}/result`,
          responseType: "json",
          onComplete: appendDebugEntry
        });
        setResult(data);
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

  useEffect(() => {
    if (!playerState) {
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
      setPlayerApiStatus("idle");
      setPlayerApiError("");
      setPlayerFocusMode(false);
      setIsControlPanelCollapsed(false);
      setIframePlaybackRequest({ startSeconds: 0, nonce: 0 });
      return;
    }

    let cancelled = false;
    let readyTimerId = 0;
    let playerReady = false;

    setPlayerApiStatus("loading");
    setPlayerApiError("");

    void loadYouTubeIframeApi()
      .then(() => {
        if (cancelled || !playerIframeRef.current || !window.YT?.Player) {
          return;
        }

        youtubePlayerRef.current?.destroy();
        youtubePlayerRef.current = new window.YT.Player(playerIframeRef.current, {
          playerVars: {
            playsinline: 1,
            rel: 0
          },
          events: {
            onReady: () => {
              if (cancelled) {
                return;
              }

              playerReady = true;
              window.clearTimeout(readyTimerId);
              setPlayerApiStatus("ready");
              setPlayerApiError("");
            },
            onError: () => {
              if (cancelled) {
                return;
              }

              window.clearTimeout(readyTimerId);
              playerReady = false;
              setPlayerApiStatus("error");
              setPlayerApiError("YouTube player API failed to initialize. The fallback embed is still available.");
            }
          }
        });

        readyTimerId = window.setTimeout(() => {
          if (cancelled || playerReady) {
            return;
          }

          setPlayerApiStatus("error");
          setPlayerApiError("YouTube player API timed out. The fallback embed is still available.");
        }, 5000);
      })
      .catch(() => {
        if (!cancelled) {
          setPlayerApiStatus("error");
          setPlayerApiError("Unable to load the YouTube player API. The fallback embed is still available.");
        }
      });

    return () => {
      cancelled = true;
      window.clearTimeout(readyTimerId);
      youtubePlayerRef.current?.destroy();
      youtubePlayerRef.current = null;
    };
  }, [playerState?.videoId]);

  useEffect(() => {
    if (!youtubePlayerRef.current || !result?.sentences.length) {
      return;
    }

    const intervalId = window.setInterval(() => {
      const player = youtubePlayerRef.current;

      if (!player) {
        return;
      }

      const currentTime = player.getCurrentTime();
      if (!Number.isFinite(currentTime)) {
        return;
      }

      const nextIndex = findSentenceIndexForTime(result.sentences, currentTime);
      if (nextIndex === null || nextIndex === activeSentenceIndexRef.current) {
        return;
      }

      activeSentenceIndexRef.current = nextIndex;
      setActiveSentenceIndex(nextIndex);

      if (isInteractiveMode) {
        scrollSentenceIntoView(nextIndex);
      }
    }, 700);

    return () => window.clearInterval(intervalId);
  }, [result, isInteractiveMode, playerState?.videoId]);

  async function submit() {
    setError("");
    setResult(null);
    setCopyStatus("");
    setResultView("transcript");
    setControlView("transcribe");
    setDisplayedProgress(0);
    setElapsedNow(Date.now());
    setEditingSentenceIndex(null);
    setPlayerFocusMode(false);
    setIsControlPanelCollapsed(false);

    if (timeRangeError) {
      setError(timeRangeError);
      return;
    }

    setIsSubmitting(true);

    try {
      const { response, data: payload } = await performTrackedRequest<JobRecord | { error?: string }>({
        url: "/api/transcriptions",
        init: {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(form)
        },
        responseType: "json",
        onComplete: appendDebugEntry
      });
      if (!response.ok) {
        setError("error" in payload ? (payload.error ?? "Unable to start transcription.") : "Unable to start transcription.");
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

    const { response, data: content } = await performTrackedRequest<string>({
      url: `/api/transcriptions/${job.id}/result?format=${format}`,
      responseType: "text",
      onComplete: appendDebugEntry
    });

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

  function updateDefaultSpeed<K extends keyof LocalSpeedSettings>(key: K, value: LocalSpeedSettings[K]) {
    setSettings((current) => ({
      ...current,
      defaultSpeed: {
        ...current.defaultSpeed,
        [key]: value
      }
    }));
    setForm((current) => ({
      ...current,
      localSpeed: {
        ...current.localSpeed,
        [key]: value
      }
    }));
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
    activeSentenceIndexRef.current = index;

    if (!playerState) {
      return;
    }

    if (!youtubePlayerRef.current) {
      setIframePlaybackRequest((current) => ({
        startSeconds: Math.max(0, Math.floor(seconds)),
        nonce: current.nonce + 1
      }));
      return;
    }

    youtubePlayerRef.current.seekTo(Math.max(0, Math.floor(seconds)), true);
    youtubePlayerRef.current.playVideo();
  }

  function scrollSentenceIntoView(index: number) {
    const row = resultPanelRef.current?.querySelector<HTMLElement>(`[data-sentence-index="${index}"]`);
    row?.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function jumpToActiveSentence() {
    if (!result || activeSentenceIndex === null) {
      return;
    }

    setPlayerFocusMode(true);
    setIsControlPanelCollapsed(true);
    seekToSentence(result.sentences[activeSentenceIndex].startSeconds, activeSentenceIndex);
    window.setTimeout(() => scrollSentenceIntoView(activeSentenceIndex), 120);
  }

  function exitInteractiveMode() {
    setPlayerFocusMode(false);
    setIsControlPanelCollapsed(false);
  }

  function restoreHistoryItem(item: HistoryItem) {
    setForm((current) => ({
      ...current,
      youtubeUrl: item.youtubeUrl,
      startTime: item.startTime ?? current.startTime,
      endTime: item.endTime ?? current.endTime
    }));
    setControlView("transcribe");
  }

  function openControlView(view: ControlView) {
    exitInteractiveMode();
    setControlView(view);
    setShowSettings(false);
  }

  function openSettingsPanel() {
    exitInteractiveMode();
    setShowSettings(true);
  }

  function updateTimeField(field: TimeFieldName, value: string) {
    setForm((current) => ({
      ...current,
      [field]: value
    }));
  }

  function handleTimeFieldKeyDown(field: TimeFieldName, event: KeyboardEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const currentValue = formatTimeInput(input.value);
    const selectionStart = input.selectionStart ?? 0;
    const selectionEnd = input.selectionEnd ?? selectionStart;
    const segmentIndex = getTimeSegmentIndex(selectionStart);
    const [segmentStart, segmentEnd] = getTimeSegmentRangeByIndex(segmentIndex);
    const fieldState = timeFieldStateRef.current[field];

    if (/^\d$/.test(event.key)) {
      event.preventDefault();

      const isContinuingSegment =
        fieldState?.segmentIndex === segmentIndex &&
        fieldState.firstDigit.length === 1 &&
        selectionStart === segmentStart + 1 &&
        selectionEnd === segmentStart + 1;
      const nextSegmentValue = clampTimeSegment(
        isContinuingSegment ? `${fieldState.firstDigit}${event.key}` : `0${event.key}`,
        segmentIndex
      );
      const nextValue = replaceTimeSegment(currentValue, segmentIndex, nextSegmentValue);

      updateTimeField(field, nextValue);

      if (isContinuingSegment) {
        timeFieldStateRef.current[field] = null;
        const nextSelection = segmentIndex < 2
          ? getTimeSegmentRangeByIndex(segmentIndex + 1)
          : [segmentEnd, segmentEnd] as const;
        window.requestAnimationFrame(() => input.setSelectionRange(nextSelection[0], nextSelection[1]));
      } else {
        timeFieldStateRef.current[field] = { segmentIndex, firstDigit: event.key };
        window.requestAnimationFrame(() => input.setSelectionRange(segmentStart + 1, segmentStart + 1));
      }

      return;
    }

    if (event.key === "Backspace" || event.key === "Delete") {
      event.preventDefault();
      const nextValue = replaceTimeSegment(currentValue, segmentIndex, "00");
      timeFieldStateRef.current[field] = null;
      updateTimeField(field, nextValue);
      window.requestAnimationFrame(() => input.setSelectionRange(segmentStart, segmentEnd));
      return;
    }

    if (event.key === ":") {
      event.preventDefault();
      timeFieldStateRef.current[field] = null;
      const nextRange = segmentIndex < 2 ? getTimeSegmentRangeByIndex(segmentIndex + 1) : getTimeSegmentRangeByIndex(2);
      window.requestAnimationFrame(() => input.setSelectionRange(nextRange[0], nextRange[1]));
      return;
    }

    if (event.key === "ArrowLeft") {
      event.preventDefault();
      timeFieldStateRef.current[field] = null;
      const nextRange = getTimeSegmentRangeByIndex(Math.max(0, segmentIndex - 1));
      window.requestAnimationFrame(() => input.setSelectionRange(nextRange[0], nextRange[1]));
      return;
    }

    if (event.key === "ArrowRight") {
      event.preventDefault();
      timeFieldStateRef.current[field] = null;
      const nextRange = getTimeSegmentRangeByIndex(Math.min(2, segmentIndex + 1));
      window.requestAnimationFrame(() => input.setSelectionRange(nextRange[0], nextRange[1]));
      return;
    }

    timeFieldStateRef.current[field] = null;
  }

  function handleTimeFieldPaste(field: TimeFieldName, event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    timeFieldStateRef.current[field] = null;
    updateTimeField(field, formatTimeInput(event.clipboardData.getData("text")));
  }

  return (
    <main className="app-shell">
      <section className={`workspace ${showCollapsedControlPanel ? "interactive-sidebar-collapsed" : ""}`}>
        <aside className={`control-panel ${showCollapsedControlPanel ? "collapsed" : ""}`} aria-label="Transcription controls">
          {showCollapsedControlPanel ? (
            <div className="control-rail" aria-label="Collapsed controls">
              <button
                className="icon-button rail-button"
                type="button"
                aria-label="Expand control panel"
                title="Expand control panel"
                onClick={exitInteractiveMode}
              >
                <PanelExpandIcon />
              </button>
              <button
                className={`icon-button rail-button ${controlView === "transcribe" && !showSettings ? "active" : ""}`}
                type="button"
                aria-label="Open transcribe panel"
                title="Transcribe"
                onClick={() => openControlView("transcribe")}
              >
                <TranscribeIcon />
              </button>
              <button
                className={`icon-button rail-button ${controlView === "history" && !showSettings ? "active" : ""}`}
                type="button"
                aria-label="Open history panel"
                title="History"
                onClick={() => openControlView("history")}
              >
                <HistoryIcon />
              </button>
              <button
                className={`icon-button rail-button ${showSettings ? "active" : ""}`}
                type="button"
                aria-label="Open local settings"
                title="Local settings"
                onClick={openSettingsPanel}
              >
                <SettingsIcon />
              </button>
              {debugEnabled ? (
                <button
                  className={`icon-button rail-button ${controlView === "debug" ? "active" : ""}`}
                  type="button"
                  aria-label="Open debug panel"
                  title="Debug"
                  onClick={() => openControlView("debug")}
                >
                  <DebugIcon />
                </button>
              ) : null}
            </div>
          ) : (
            <>
          <div className="control-header">
            <div
              className="segmented control-tabs"
              role="tablist"
              aria-label="Control views"
              style={{ gridTemplateColumns: `repeat(${debugEnabled ? 3 : 2}, 1fr)` }}
            >
              <button className={controlView === "transcribe" ? "active" : ""} type="button" onClick={() => openControlView("transcribe")}>
                Transcribe
              </button>
              <button className={controlView === "history" ? "active" : ""} type="button" onClick={() => openControlView("history")}>
                History
              </button>
              {debugEnabled ? (
                <button className={controlView === "debug" ? "active" : ""} type="button" onClick={() => openControlView("debug")}>
                  Debug
                </button>
              ) : null}
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
          {controlView === "transcribe" ? (
            <div className="top-action-bar">
              <button
                className={`primary top-primary ${isSubmitting || isWorking ? "busy" : ""}`}
                type="button"
                onClick={submit}
                disabled={isSubmitting || isWorking || Boolean(timeRangeError)}
                aria-busy={isSubmitting || isWorking}
              >
                {isSubmitting || isWorking ? <span className="button-spinner" aria-hidden="true" /> : null}
                <span>{isSubmitting ? "Starting..." : isWorking ? "Transcribing..." : "Transcribe Segment"}</span>
              </button>
            </div>
          ) : null}
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
              <div className="settings-divider" />
              <div>
                <p className="eyebrow">Local Optimization</p>
                <h2>Defaults</h2>
              </div>
              <div className="speed-grid">
                <label>
                  Beam size
                  <input
                    inputMode="numeric"
                    min="1"
                    max="10"
                    type="number"
                    value={settings.defaultSpeed.beamSize}
                    onChange={(event) => updateDefaultSpeed("beamSize", clampNumber(event.target.value, 1, 10, settings.defaultSpeed.beamSize))}
                  />
                </label>
                <label>
                  Best of
                  <input
                    inputMode="numeric"
                    min="1"
                    max="10"
                    type="number"
                    value={settings.defaultSpeed.bestOf}
                    onChange={(event) => updateDefaultSpeed("bestOf", clampNumber(event.target.value, 1, 10, settings.defaultSpeed.bestOf))}
                  />
                </label>
                <label>
                  Threads
                  <input
                    inputMode="numeric"
                    min="1"
                    max="32"
                    type="number"
                    value={settings.defaultSpeed.threads}
                    onChange={(event) => updateDefaultSpeed("threads", clampNumber(event.target.value, 1, 32, settings.defaultSpeed.threads))}
                  />
                </label>
                <label className="checkbox-row speed-toggle">
                  <input
                    type="checkbox"
                    checked={settings.defaultSpeed.vadEnabled}
                    onChange={(event) => updateDefaultSpeed("vadEnabled", event.target.checked)}
                  />
                  VAD silence skip
                </label>
              </div>
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
                          <span>{formatHistoryRange(item.startTime, item.endTime)}</span>
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
          ) : controlView === "debug" ? (
            <section className="debug-panel" aria-label="Debug network panel">
              <div className="debug-panel-header">
                <div>
                  <p className="eyebrow">Hidden Debug</p>
                  <h2>Client request log</h2>
                </div>
                <button className="icon-button" type="button" onClick={() => setDebugEntries([])} aria-label="Clear debug log" title="Clear debug log">
                  <CloseIcon />
                </button>
              </div>
              <p className="subtle debug-hint">
                Toggle this panel with <kbd>Ctrl</kbd>+<kbd>Shift</kbd>+<kbd>D</kbd>. It records frontend requests to the local API, including status, duration, request payload, and a response snippet.
              </p>
              <div className="debug-log-list">
                {debugEntries.length > 0 ? (
                  debugEntries.map((entry) => (
                    <article className="debug-log-card" key={entry.id}>
                      <div className="debug-log-topline">
                        <strong>{entry.method}</strong>
                        <span>{entry.url}</span>
                      </div>
                      <div className="debug-log-meta">
                        <span>{entry.status ? `HTTP ${entry.status}` : "Request error"}</span>
                        <span>{Math.round(entry.durationMs)} ms</span>
                        <span>{formatSavedAt(entry.startedAt)}</span>
                      </div>
                      {entry.error ? <p className="error debug-log-error">{entry.error}</p> : null}
                      {entry.requestBody ? (
                        <details>
                          <summary>Request</summary>
                          <pre>{entry.requestBody}</pre>
                        </details>
                      ) : null}
                      {entry.responseBody ? (
                        <details>
                          <summary>Response</summary>
                          <pre>{entry.responseBody}</pre>
                        </details>
                      ) : null}
                    </article>
                  ))
                ) : (
                  <div className="empty-history">
                    <p className="eyebrow">Debug</p>
                    <h2>No requests captured yet</h2>
                    <p>Start metadata lookup or a transcription job to inspect the client API traffic.</p>
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
                onClick={handleTimeFieldClick}
                onFocus={handleTimeFieldFocus}
                onKeyDown={(event) => handleTimeFieldKeyDown("startTime", event)}
                onPaste={(event) => handleTimeFieldPaste("startTime", event)}
              />
            </label>
            <label>
              End
              <input
                inputMode="numeric"
                value={form.endTime}
                onChange={(event) => setForm({ ...form, endTime: formatTimeInput(event.target.value) })}
                onClick={handleTimeFieldClick}
                onFocus={handleTimeFieldFocus}
                onKeyDown={(event) => handleTimeFieldKeyDown("endTime", event)}
                onPaste={(event) => handleTimeFieldPaste("endTime", event)}
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

          {health?.gpuStatus ? (
            <p className="subtle gpu-status live">
              <span className="gpu-pulse" aria-hidden="true" />
              {formatGpuStatus(health.gpuStatus)}
            </p>
          ) : null}

          {error ? <p className="error">{error}</p> : null}
          {timeRangeError ? <p className="error">{timeRangeError}</p> : null}
          {job?.status === "failed" ? <p className="error">{job.error}</p> : null}

            </>
          )}
            </>
          )}
        </aside>

        <section className={`result-panel ${isInteractiveMode ? "focus-layout" : ""}`} aria-label="Transcript result" ref={resultPanelRef}>
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
                      <p className="eyebrow">{isInteractiveMode ? "Interactive Mode" : "Playback"}</p>
                      <h3>{isInteractiveMode ? "Interactive transcript sync" : "Synced YouTube player"}</h3>
                    </div>
                    <div className="player-actions">
                      {playerFocusMode ? (
                        <button type="button" onClick={exitInteractiveMode}>
                          Exit Interactive Mode
                        </button>
                      ) : null}
                      <button type="button" onClick={jumpToActiveSentence}>
                        {isInteractiveMode ? "Sync Active Line" : "Enter Interactive Mode"}
                      </button>
                    </div>
                  </div>
                  <div className="player-frame-wrap">
                    <iframe
                      key={`${playerState.videoId}-${iframePlaybackRequest.nonce}`}
                      ref={playerIframeRef}
                      className="player-host"
                      src={buildPlayerEmbedUrl(playerState, iframePlaybackRequest.startSeconds, iframePlaybackRequest.nonce > 0)}
                      title="YouTube player"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
                      allowFullScreen
                      referrerPolicy="strict-origin-when-cross-origin"
                    />
                  </div>
                  {playerApiStatus === "error" ? <p className="warning player-warning">{playerApiError}</p> : null}
                </section>
              ) : null}
              {!isInteractiveMode ? (
                <>
                  <div className="result-header">
                    <div>
                      <p className="eyebrow">Transcript</p>
                      <h2>{result.sentences.length} sentences</h2>
                      <p className="subtle">
                        {result.provider} - {result.model} - {reviewCount} need review
                        {result.partial && result.totalChunks
                          ? ` - live ${result.completedChunks ?? 0}/${result.totalChunks} chunks`
                          : ""}
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
                </>
              ) : (
                <div className="interactive-summary-bar">
                  <span>{result.sentences.length} sentences</span>
                  <span>{result.provider}</span>
                  <span>{result.model}</span>
                  <span>{reviewCount} need review</span>
                  {result.partial && result.totalChunks ? <span>live {result.completedChunks ?? 0}/{result.totalChunks}</span> : null}
                </div>
              )}
              {isInteractiveMode ? (
                <section className="interactive-toolbar" aria-label="Interactive transcript controls">
                  <div className="segmented result-tabs interactive-tabs" role="tablist" aria-label="Result views">
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
                      Paragraph
                    </button>
                  </div>
                  {resultView === "transcript" ? (
                    <div className="segmented review-filters interactive-filters" role="tablist" aria-label="Review filters">
                      <button className={reviewFilter === "all" ? "active" : ""} type="button" onClick={() => setReviewFilter("all")}>
                        All
                      </button>
                      <button
                        className={reviewFilter === "needs-review" ? "active" : ""}
                        type="button"
                        onClick={() => setReviewFilter("needs-review")}
                      >
                        Review
                      </button>
                      <button
                        className={reviewFilter === "approved" ? "active" : ""}
                        type="button"
                        onClick={() => setReviewFilter("approved")}
                      >
                        Approved
                      </button>
                      <button
                        className={reviewFilter === "edited" ? "active" : ""}
                        type="button"
                        onClick={() => setReviewFilter("edited")}
                      >
                        Edited
                      </button>
                    </div>
                  ) : null}
                  <div className="export-actions interactive-export-actions">
                    <button type="button" onClick={() => exportResult("txt")}>TXT</button>
                    <button type="button" onClick={() => exportResult("srt")}>SRT</button>
                    <button type="button" onClick={() => exportResult("json")}>JSON</button>
                  </div>
                </section>
              ) : null}
              {resultView === "transcript" ? (
                <>
                  {!isInteractiveMode ? (
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
                  ) : null}
                  <div className={isInteractiveMode ? "interactive-content-pane" : undefined}>
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
                  </div>
                </>
              ) : (
                <div className={isInteractiveMode ? "interactive-content-pane plain-pane" : undefined}>
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
                </div>
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
  if (value.includes(":")) {
    return formatClockSegments(value);
  }

  const digits = value.replace(/\D/g, "").slice(0, 6);

  if (!digits) {
    return "00:00:00";
  }

  const padded = digits.padStart(6, "0");
  return formatClockSegments(`${padded.slice(0, 2)}:${padded.slice(2, 4)}:${padded.slice(4, 6)}`);
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
      defaultModel: isLocalModel(parsed.defaultModel) ? parsed.defaultModel : defaultLocalSettings.defaultModel,
      defaultSpeed: {
        beamSize: clampLoadedNumber(parsed.defaultSpeed?.beamSize, 1, 10, defaultLocalSettings.defaultSpeed.beamSize),
        bestOf: clampLoadedNumber(parsed.defaultSpeed?.bestOf, 1, 10, defaultLocalSettings.defaultSpeed.bestOf),
        threads: clampLoadedNumber(parsed.defaultSpeed?.threads, 1, 32, defaultLocalSettings.defaultSpeed.threads),
        vadEnabled: typeof parsed.defaultSpeed?.vadEnabled === "boolean" ? parsed.defaultSpeed.vadEnabled : defaultLocalSettings.defaultSpeed.vadEnabled
      }
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

function clampNumber(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function clampLoadedNumber(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

function formatGpuStatus(gpuStatus: GpuStatus): string {
  if (!gpuStatus.available) {
    return "GPU: CPU mode";
  }

  const device = gpuStatus.devices[0] ?? "Unknown GPU";
  const metrics = [
    gpuStatus.utilizationPercent !== undefined ? `${Math.round(gpuStatus.utilizationPercent)}% util` : "",
    gpuStatus.memoryUsedMiB !== undefined && gpuStatus.memoryTotalMiB !== undefined
      ? `${Math.round(gpuStatus.memoryUsedMiB)} / ${Math.round(gpuStatus.memoryTotalMiB)} MiB`
      : ""
  ].filter(Boolean);

  return `GPU: ${gpuStatus.backend.toUpperCase()} - ${device}${metrics.length > 0 ? ` - ${metrics.join(" - ")}` : ""}`;
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

function createHistoryItem(youtubeUrl: string, metadata: VideoMetadata | null, startTime: string, endTime: string): HistoryItem {
  const videoId = metadata?.id ?? extractYoutubeVideoId(youtubeUrl) ?? "unknown";

  return {
    youtubeUrl,
    title: metadata?.title?.trim() || youtubeUrl,
    thumbnailUrl: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
    durationSeconds: metadata?.durationSeconds,
    startTime,
    endTime,
    savedAt: new Date().toISOString()
  };
}

function formatClockSegments(value: string): string {
  const parts = value
    .split(":")
    .slice(0, 3)
    .map((part) => part.replace(/\D/g, "").slice(0, 2));

  if (parts.length === 2) {
    parts.unshift("00");
  }

  while (parts.length < 3) {
    parts.push("00");
  }

  return parts
    .map((part, index) => {
      const max = index === 0 ? 99 : 59;
      const parsed = Number.parseInt(part || "0", 10);
      const safe = Number.isFinite(parsed) ? Math.min(max, Math.max(0, parsed)) : 0;
      return String(safe).padStart(2, "0");
    })
    .join(":");
}

function getTimeSegmentIndex(position: number): number {
  if (position <= 2) {
    return 0;
  }

  if (position <= 5) {
    return 1;
  }

  return 2;
}

function getTimeSegmentRangeByIndex(segmentIndex: number): [number, number] {
  if (segmentIndex <= 0) {
    return [0, 2];
  }

  if (segmentIndex === 1) {
    return [3, 5];
  }

  return [6, 8];
}

function clampTimeSegment(value: string, segmentIndex: number): string {
  const max = segmentIndex === 0 ? 99 : 59;
  const parsed = Number.parseInt(value.replace(/\D/g, "") || "0", 10);
  return String(Math.min(max, Math.max(0, parsed))).padStart(2, "0");
}

function replaceTimeSegment(value: string, segmentIndex: number, nextSegmentValue: string): string {
  const normalized = formatTimeInput(value);
  const [start, end] = getTimeSegmentRangeByIndex(segmentIndex);
  return `${normalized.slice(0, start)}${nextSegmentValue}${normalized.slice(end)}`;
}

function selectTimeSegment(input: HTMLInputElement, position: number | null | undefined) {
  const [start, end] = getTimeSegmentRangeByIndex(getTimeSegmentIndex(position ?? input.selectionStart ?? 0));
  window.requestAnimationFrame(() => input.setSelectionRange(start, end));
}

function handleTimeFieldClick(event: MouseEvent<HTMLInputElement>) {
  selectTimeSegment(event.currentTarget, event.currentTarget.selectionStart);
}

function handleTimeFieldFocus(event: FocusEvent<HTMLInputElement>) {
  selectTimeSegment(event.currentTarget, event.currentTarget.selectionStart);
}

function formatHistoryRange(startTime?: string, endTime?: string): string {
  if (!startTime || !endTime) {
    return "Full range";
  }

  return `${startTime} to ${endTime}`;
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

function buildPlayerEmbedUrl(playerState: PlayerState, startSeconds = 0, autoplay = false): string {
  const url = new URL(playerState.embedUrl);
  url.searchParams.set("origin", window.location.origin);

  if (startSeconds > 0) {
    url.searchParams.set("start", String(Math.floor(startSeconds)));
  } else {
    url.searchParams.delete("start");
  }

  url.searchParams.set("autoplay", autoplay ? "1" : "0");
  return url.toString();
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

function SettingsIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3.25" />
      <path d="M12 2.75v2.1" />
      <path d="M12 19.15v2.1" />
      <path d="m4.93 4.93 1.49 1.49" />
      <path d="m17.58 17.58 1.49 1.49" />
      <path d="M2.75 12h2.1" />
      <path d="M19.15 12h2.1" />
      <path d="m4.93 19.07 1.49-1.49" />
      <path d="m17.58 6.42 1.49-1.49" />
    </svg>
  );
}

function DebugIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="5" width="16" height="14" rx="2.5" />
      <path d="M9 9h6" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </svg>
  );
}

function PanelExpandIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <path d="M8.5 7.5v9" />
      <path d="m12.5 12 3-3" />
      <path d="m12.5 12 3 3" />
    </svg>
  );
}

function TranscribeIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 10.5h2.5" />
      <path d="M9 7.5v9" />
      <path d="M12 5.5v13" />
      <path d="M15 8.5v7" />
      <path d="M18 10.5h2" />
    </svg>
  );
}

function HistoryIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 12a8.5 8.5 0 1 0 2.49-6.01" />
      <path d="M3.5 4.5v4h4" />
      <path d="M12 7.5v5l3 2" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="m6 6 12 12" />
      <path d="M18 6 6 18" />
    </svg>
  );
}

interface YoutubePlayer {
  destroy(): void;
  getCurrentTime(): number;
  playVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
}

interface YoutubePlayerEvent {
  target: YoutubePlayer;
}

declare global {
  interface Window {
    onYouTubeIframeAPIReady?: () => void;
    YT?: {
      Player: new (
        element: HTMLElement | HTMLIFrameElement,
        options: {
          videoId?: string;
          playerVars?: Record<string, number>;
          events?: {
            onReady?: (event: YoutubePlayerEvent) => void;
            onError?: () => void;
          };
        }
      ) => YoutubePlayer;
    };
  }
}

let youtubeIframeApiPromise: Promise<void> | null = null;

function loadYouTubeIframeApi(): Promise<void> {
  if (window.YT?.Player) {
    return Promise.resolve();
  }

  if (youtubeIframeApiPromise) {
    return youtubeIframeApiPromise;
  }

  youtubeIframeApiPromise = new Promise<void>((resolve, reject) => {
    const existingScript = document.querySelector<HTMLScriptElement>('script[src="https://www.youtube.com/iframe_api"]');
    if (!existingScript) {
      const script = document.createElement("script");
      script.src = "https://www.youtube.com/iframe_api";
      script.onerror = () => reject(new Error("Failed to load the YouTube iframe API."));
      document.head.appendChild(script);
    }

    const previous = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      previous?.();
      resolve();
    };
  });

  return youtubeIframeApiPromise;
}

async function performTrackedRequest<T>({
  url,
  init,
  responseType,
  onComplete
}: {
  url: string;
  init?: RequestInit;
  responseType: "json" | "text";
  onComplete: (entry: Omit<DebugEntry, "id">) => void;
}): Promise<{ response: Response; data: T }> {
  const startedAt = new Date().toISOString();
  const started = performance.now();
  const method = init?.method ?? "GET";
  const requestBody = summarizeRequestBody(init?.body);

  try {
    const response = await fetch(url, init);
    const rawBody = await response.text();

    onComplete({
      method,
      url,
      startedAt,
      durationMs: performance.now() - started,
      status: response.status,
      requestBody,
      responseBody: truncateDebugText(rawBody)
    });

    const data = (responseType === "json" ? (rawBody ? JSON.parse(rawBody) : {}) : rawBody) as T;
    return { response, data };
  } catch (error) {
    onComplete({
      method,
      url,
      startedAt,
      durationMs: performance.now() - started,
      requestBody,
      error: error instanceof Error ? error.message : "Request failed"
    });
    throw error;
  }
}

function summarizeRequestBody(body: RequestInit["body"]): string | undefined {
  if (!body || typeof body !== "string") {
    return undefined;
  }

  return truncateDebugText(body);
}

function truncateDebugText(value: string, maxLength = 1200): string {
  const normalized = value.trim();

  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength)}…`;
}

function findSentenceIndexForTime(sentences: TranscriptionResult["sentences"], currentTime: number): number | null {
  if (sentences.length === 0) {
    return null;
  }

  for (let index = 0; index < sentences.length; index += 1) {
    const sentence = sentences[index];
    const next = sentences[index + 1];
    const endBoundary = next ? next.startSeconds : sentence.endSeconds + 0.75;

    if (currentTime >= sentence.startSeconds && currentTime < endBoundary) {
      return index;
    }
  }

  return currentTime < sentences[0].startSeconds ? 0 : sentences.length - 1;
}
