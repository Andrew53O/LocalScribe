import type { Highlight, TranscriptSentence } from "../../shared/types";

type ReviewState = "pending" | "approved" | "needs-review" | "edited";

interface ReviewDraft {
  text: string;
  reviewState: ReviewState;
  note: string;
}

interface Props {
  sentences: TranscriptSentence[];
  visibleSentenceIndices?: number[];
  activeSentenceIndex?: number;
  onSeek?: (seconds: number, index: number) => void;
  reviewDrafts?: ReviewDraft[];
  editingSentenceIndex?: number | null;
  onStartEditing?: (index: number) => void;
  onStopEditing?: () => void;
  onReviewStateChange?: (index: number, reviewState: ReviewState) => void;
  onDraftTextChange?: (index: number, text: string) => void;
  onResetSentence?: (index: number) => void;
}

export function TranscriptView({
  sentences,
  visibleSentenceIndices,
  activeSentenceIndex,
  onSeek,
  reviewDrafts,
  editingSentenceIndex,
  onStartEditing,
  onStopEditing,
  onReviewStateChange,
  onDraftTextChange,
  onResetSentence
}: Props) {
  const indices = visibleSentenceIndices ?? sentences.map((_, index) => index);

  return (
    <div className="sentence-list">
      {indices.map((index) => {
        const sentence = sentences[index];
        const draft = reviewDrafts?.[index];
        const reviewState = draft?.reviewState ?? (sentence.qualityStatus === "review" ? "needs-review" : "pending");

        return (
          <article
            className={`sentence-row ${sentence.qualityStatus} ${activeSentenceIndex === index ? "active" : ""}`}
            key={`${sentence.startSeconds}-${index}`}
          >
          <div className="sentence-meta">
            <button className="timestamp-link" type="button" onClick={() => onSeek?.(sentence.startSeconds, index)}>
              {formatTime(sentence.startSeconds)}
            </button>
            <span>{sentence.speakerLabel}</span>
            <span>{sentence.detectedLanguage}</span>
            {reviewState === "needs-review" ? <strong>Review</strong> : <span>{labelReviewState(reviewState)}</span>}
          </div>
          <div className="sentence-content">
            {editingSentenceIndex === index ? (
              <textarea
                className="sentence-editor"
                value={draft?.text ?? sentence.text}
                onChange={(event) => onDraftTextChange?.(index, event.target.value)}
                spellCheck="false"
              />
            ) : (
              <button className="sentence-text" type="button" onClick={() => onSeek?.(sentence.startSeconds, index)}>
                {renderHighlighted(sentence.text, sentence.highlights)}
              </button>
            )}
            <div className="sentence-actions">
              <button type="button" onClick={() => onReviewStateChange?.(index, "approved")}>Approve</button>
              <button type="button" onClick={() => onReviewStateChange?.(index, "needs-review")}>Needs review</button>
              {editingSentenceIndex === index ? (
                <button type="button" onClick={() => onStopEditing?.()}>Done</button>
              ) : (
                <button type="button" onClick={() => onStartEditing?.(index)}>Edit</button>
              )}
              <button type="button" onClick={() => onResetSentence?.(index)}>Reset</button>
            </div>
          </div>
        </article>
        );
      })}
    </div>
  );
}

function labelReviewState(reviewState: ReviewState) {
  if (reviewState === "approved") {
    return "Approved";
  }

  if (reviewState === "edited") {
    return "Edited";
  }

  return "Pending";
}

function renderHighlighted(text: string, highlights: Highlight[]) {
  if (highlights.length === 0) {
    return text;
  }

  const nodes: JSX.Element[] = [];
  let cursor = 0;

  highlights.forEach((highlight, index) => {
    if (highlight.startChar > cursor) {
      nodes.push(<span key={`text-${index}`}>{text.slice(cursor, highlight.startChar)}</span>);
    }

    nodes.push(
      <mark className={highlight.severity} key={`highlight-${index}`} title={highlight.reason}>
        {text.slice(highlight.startChar, highlight.endChar)}
      </mark>
    );
    cursor = Math.max(cursor, highlight.endChar);
  });

  if (cursor < text.length) {
    nodes.push(<span key="tail">{text.slice(cursor)}</span>);
  }

  return nodes;
}

function formatTime(totalSeconds: number) {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  return [hours, minutes, seconds].map((part) => String(part).padStart(2, "0")).join(":");
}
