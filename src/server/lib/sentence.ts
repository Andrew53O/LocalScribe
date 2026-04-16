import type { LanguageHint, TranscriptSentence, WhisperSegment } from "../../shared/types.js";

const SENTENCE_END = /[.!?。！？]+["')\]]*|\n+/gu;

interface SentencePiece {
  text: string;
  startOffset: number;
  endOffset: number;
}

export function splitTextIntoSentences(text: string): SentencePiece[] {
  const clean = text.replace(/\s+/g, " ").trim();

  if (!clean) {
    return [];
  }

  const pieces: SentencePiece[] = [];
  let start = 0;
  let match: RegExpExecArray | null;

  while ((match = SENTENCE_END.exec(clean)) !== null) {
    const end = match.index + match[0].length;
    const slice = clean.slice(start, end).trim();

    if (slice) {
      pieces.push({
        text: slice,
        startOffset: start,
        endOffset: end
      });
    }

    start = end;
  }

  const rest = clean.slice(start).trim();
  if (rest) {
    pieces.push({
      text: rest,
      startOffset: start,
      endOffset: clean.length
    });
  }

  return pieces;
}

export function segmentsToSentences(segments: WhisperSegment[], languageHint: LanguageHint): TranscriptSentence[] {
  const sentences: TranscriptSentence[] = [];

  for (const segment of segments) {
    const pieces = splitTextIntoSentences(segment.text);

    if (pieces.length === 0) {
      continue;
    }

    const segmentTextLength = pieces.reduce((sum, piece) => sum + piece.text.length, 0) || segment.text.length || 1;
    let currentStart = segment.start;

    for (const piece of pieces) {
      const ratio = piece.text.length / segmentTextLength;
      const duration = Math.max(0.4, (segment.end - segment.start) * ratio);
      const currentEnd = Math.min(segment.end, currentStart + duration);

      sentences.push({
        startSeconds: currentStart,
        endSeconds: currentEnd,
        text: piece.text,
        detectedLanguage: detectLanguage(piece.text, languageHint),
        speakerLabel: "",
        qualityStatus: "ok",
        highlights: []
      });

      currentStart = currentEnd;
    }
  }

  return sentences;
}

export function detectLanguage(text: string, hint: LanguageHint): LanguageHint {
  if (hint !== "auto") {
    return hint;
  }

  const chineseCount = [...text].filter((char) => /[\u3400-\u9fff]/u.test(char)).length;
  if (chineseCount >= 2) {
    return "zh-TW";
  }

  const lower = text.toLowerCase();
  const indonesianSignals = [" yang ", " dan ", " untuk ", " dengan ", " karena ", " tidak ", " adalah "];
  if (indonesianSignals.some((signal) => ` ${lower} `.includes(signal))) {
    return "id";
  }

  return "en";
}
