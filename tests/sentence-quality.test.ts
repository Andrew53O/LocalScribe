import { describe, expect, it } from "vitest";
import { applyQualityHighlights } from "../src/server/lib/quality";
import { segmentsToSentences, splitTextIntoSentences } from "../src/server/lib/sentence";

describe("sentence processing", () => {
  it("splits English, Indonesian, and Chinese punctuation", () => {
    expect(splitTextIntoSentences("Hello world. Apa kabar? 這是一句話。")).toHaveLength(3);
  });

  it("preserves English code-switching in Indonesian or Chinese text", () => {
    const sentences = segmentsToSentences(
      [{ start: 0, end: 3, text: "Kita pakai Docker container untuk deploy." }],
      "auto"
    );

    expect(sentences[0].text).toContain("Docker container");
    expect(sentences[0].detectedLanguage).toBe("id");
  });

  it("flags repeated words and short fragments", () => {
    const sentences = segmentsToSentences([{ start: 0, end: 4, text: "test test test. ok." }], "en");
    const reviewed = applyQualityHighlights(sentences, [{ start: 0, end: 4, text: "test test test. ok.", confidence: 0.9 }]);

    expect(reviewed.some((sentence) => sentence.qualityStatus === "review")).toBe(true);
  });
});
