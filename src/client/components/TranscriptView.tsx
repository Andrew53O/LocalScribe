import type { Highlight, TranscriptSentence } from "../../shared/types";

interface Props {
  sentences: TranscriptSentence[];
  activeSentenceIndex?: number;
  onSeek?: (seconds: number, index: number) => void;
}

export function TranscriptView({ sentences, activeSentenceIndex, onSeek }: Props) {
  return (
    <div className="sentence-list">
      {sentences.map((sentence, index) => (
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
            {sentence.qualityStatus === "review" ? <strong>Review</strong> : <span>OK</span>}
          </div>
          <button className="sentence-text" type="button" onClick={() => onSeek?.(sentence.startSeconds, index)}>
            {renderHighlighted(sentence.text, sentence.highlights)}
          </button>
        </article>
      ))}
    </div>
  );
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
