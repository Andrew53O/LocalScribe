import { describe, expect, it } from "vitest";
import { buildChunkPlan } from "../src/server/services/audio";

describe("audio chunk planning", () => {
  it("builds 90 second chunks for long ranges", () => {
    expect(buildChunkPlan(200)).toEqual([
      { index: 0, startSeconds: 0, durationSeconds: 90 },
      { index: 1, startSeconds: 90, durationSeconds: 90 },
      { index: 2, startSeconds: 180, durationSeconds: 20 }
    ]);
  });

  it("returns no chunks for empty duration", () => {
    expect(buildChunkPlan(0)).toEqual([]);
  });
});
