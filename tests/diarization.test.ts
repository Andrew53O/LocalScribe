import { describe, expect, it } from "vitest";
import { applyHeuristicSpeakerDiarization } from "../src/server/lib/diarization";
import type { TranscriptSentence } from "../src/shared/types";

function createSentence(
  text: string,
  startSeconds: number,
  endSeconds: number,
  speakerLabel = ""
): TranscriptSentence {
  return {
    startSeconds,
    endSeconds,
    text,
    detectedLanguage: "en",
    speakerLabel,
    qualityStatus: "ok",
    highlights: []
  };
}

describe("heuristic speaker diarization", () => {
  it("starts with Speaker 1", () => {
    const sentences = applyHeuristicSpeakerDiarization([createSentence("Hello there.", 0, 1.5)]);
    expect(sentences[0].speakerLabel).toBe("Speaker 1");
  });

  it("switches speakers after a question and short response", () => {
    const sentences = applyHeuristicSpeakerDiarization([
      createSentence("Can you explain that?", 0, 2),
      createSentence("Yes.", 2.1, 2.7)
    ]);

    expect(sentences[0].speakerLabel).toBe("Speaker 1");
    expect(sentences[1].speakerLabel).toBe("Speaker 2");
  });
});
