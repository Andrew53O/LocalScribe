import type { Highlight, TranscriptSentence, WhisperSegment } from "../../shared/types.js";

const LATIN_WORD = /[A-Za-z][A-Za-z'’-]*/gu;
const REPEATED_WORD = /\b([\p{L}\p{N}]{2,})(?:\s+\1){2,}\b/giu;
const REPEATED_CHINESE = /([\u3400-\u9fff])\1{3,}/gu;
const SYMBOL_NOISE = /[^\s\p{L}\p{N}\p{Script=Han}.,!?;:'"()\-，。！？、；：「」『』%$#@/]+/gu;

export function applyQualityHighlights(
  sentences: TranscriptSentence[],
  sourceSegments: WhisperSegment[]
): TranscriptSentence[] {
  return sentences.map((sentence) => {
    const highlights: Highlight[] = [];
    const text = sentence.text.trim();

    if (text.length > 0 && text.length < 5) {
      highlights.push({
        startChar: 0,
        endChar: sentence.text.length,
        severity: "warning",
        reason: "Very short fragment. Check whether this is a complete sentence."
      });
    }

    if (text.length > 140 && !/[.!?。！？]$/u.test(text)) {
      highlights.push({
        startChar: 0,
        endChar: sentence.text.length,
        severity: "warning",
        reason: "Long sentence without clear ending punctuation."
      });
    }

    collectMatches(sentence.text, REPEATED_WORD, highlights, "Repeated word pattern.", "warning");
    collectMatches(sentence.text, REPEATED_CHINESE, highlights, "Repeated Chinese character pattern.", "warning");
    collectMatches(sentence.text, SYMBOL_NOISE, highlights, "Unusual symbol sequence.", "danger");

    const segment = sourceSegments.find(
      (item) => sentence.startSeconds >= item.start - 0.2 && sentence.endSeconds <= item.end + 0.2
    );

    if (segment?.confidence !== undefined && segment.confidence < 0.35) {
      highlights.push({
        startChar: 0,
        endChar: sentence.text.length,
        severity: "danger",
        reason: "Low transcription confidence from local model.",
        confidence: segment.confidence
      });
    }

    if (looksLikeBrokenLatinCodeSwitch(sentence.text)) {
      highlights.push({
        startChar: 0,
        endChar: sentence.text.length,
        severity: "warning",
        reason: "Many tiny Latin fragments. Check mixed-language transcription."
      });
    }

    return {
      ...sentence,
      qualityStatus: highlights.length > 0 ? "review" : "ok",
      highlights: mergeHighlights(highlights, sentence.text.length)
    };
  });
}

function collectMatches(
  text: string,
  regex: RegExp,
  highlights: Highlight[],
  reason: string,
  severity: Highlight["severity"]
) {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = regex.exec(text)) !== null) {
    highlights.push({
      startChar: match.index,
      endChar: match.index + match[0].length,
      severity,
      reason
    });
  }
}

function looksLikeBrokenLatinCodeSwitch(text: string): boolean {
  const words = [...text.matchAll(LATIN_WORD)].map((match) => match[0]);

  if (words.length < 6) {
    return false;
  }

  const tiny = words.filter((word) => word.length <= 2).length;
  return tiny / words.length > 0.6;
}

function mergeHighlights(highlights: Highlight[], textLength: number): Highlight[] {
  return highlights
    .map((highlight) => ({
      ...highlight,
      startChar: Math.max(0, Math.min(textLength, highlight.startChar)),
      endChar: Math.max(0, Math.min(textLength, highlight.endChar))
    }))
    .filter((highlight) => highlight.endChar > highlight.startChar)
    .sort((a, b) => a.startChar - b.startChar);
}
