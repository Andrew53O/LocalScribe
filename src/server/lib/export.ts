import type { TranscriptionResult } from "../../shared/types.js";
import { formatTimestamp } from "./time.js";

export function resultToText(result: TranscriptionResult): string {
  return result.sentences
    .map((sentence) => `[${formatTimestamp(sentence.startSeconds)}] ${sentence.text}`)
    .join("\n");
}

export function resultToSrt(result: TranscriptionResult): string {
  return result.sentences
    .map((sentence, index) => {
      const start = formatSrtTimestamp(sentence.startSeconds);
      const end = formatSrtTimestamp(sentence.endSeconds);
      return `${index + 1}\n${start} --> ${end}\n${sentence.text}`;
    })
    .join("\n\n");
}

function formatSrtTimestamp(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const milliseconds = Math.floor((seconds - whole) * 1000);
  return `${formatTimestamp(whole)},${String(milliseconds).padStart(3, "0")}`;
}
