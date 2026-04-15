import { describe, expect, it } from "vitest";
import { formatTimestamp, parseTimestamp, validateRange } from "../src/server/lib/time";

describe("time helpers", () => {
  it("parses HH:MM:SS and MM:SS", () => {
    expect(parseTimestamp("01:02:03")).toBe(3723);
    expect(parseTimestamp("02:03")).toBe(123);
  });

  it("formats timestamps", () => {
    expect(formatTimestamp(3723)).toBe("01:02:03");
  });

  it("rejects invalid ranges", () => {
    expect(() => validateRange("00:02:00", "00:01:00")).toThrow("End time");
  });
});
