import type { TranscriptSentence } from "../../shared/types.js";

const RESPONSE_CUE = /^(yes|yeah|yep|no|ok|okay|right|well|sure|uh|um|對|對啊|好|是|不是|嗯|喔|哦|欸|ya|iya|tidak|nggak|oke|baik)\b/iu;
const QUESTION_END = /[?？]$/u;

export function applyHeuristicSpeakerDiarization(sentences: TranscriptSentence[]): TranscriptSentence[] {
  if (sentences.length === 0) {
    return sentences;
  }

  let currentSpeaker = 1;

  return sentences.map((sentence, index) => {
    if (index === 0) {
      return {
        ...sentence,
        speakerLabel: "Speaker 1"
      };
    }

    const previous = sentences[index - 1];
    const gapSeconds = Math.max(0, sentence.startSeconds - previous.endSeconds);
    const shouldChangeSpeaker =
      gapSeconds >= 1.8 ||
      QUESTION_END.test(previous.text.trim()) ||
      isShortResponse(sentence.text) ||
      (gapSeconds >= 1.0 && looksLikeResponse(sentence.text));

    if (shouldChangeSpeaker) {
      currentSpeaker = currentSpeaker === 1 ? 2 : 1;
    }

    return {
      ...sentence,
      speakerLabel: `Speaker ${currentSpeaker}`
    };
  });
}

function isShortResponse(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && trimmed.length <= 18 && looksLikeResponse(trimmed);
}

function looksLikeResponse(text: string): boolean {
  return RESPONSE_CUE.test(text.trim());
}
