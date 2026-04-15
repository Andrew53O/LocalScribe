const TIME_PATTERN = /^(?:(\d{1,2}):)?([0-5]?\d):([0-5]\d)$/;

export function parseTimestamp(value: string): number {
  const trimmed = value.trim();
  const match = TIME_PATTERN.exec(trimmed);

  if (!match) {
    throw new Error("Use HH:MM:SS or MM:SS time format.");
  }

  const hours = match[1] ? Number(match[1]) : 0;
  const minutes = Number(match[2]);
  const seconds = Number(match[3]);

  return hours * 3600 + minutes * 60 + seconds;
}

export function formatTimestamp(totalSeconds: number): string {
  const safe = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const seconds = safe % 60;

  return [hours, minutes, seconds]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

export function validateRange(startTime: string, endTime: string, maxSeconds = 7200) {
  const startSeconds = parseTimestamp(startTime);
  const endSeconds = parseTimestamp(endTime);

  if (endSeconds <= startSeconds) {
    throw new Error("End time must be after start time.");
  }

  if (endSeconds - startSeconds > maxSeconds) {
    throw new Error("Selected range is too long. Keep it under 2 hours.");
  }

  return {
    startSeconds,
    endSeconds,
    durationSeconds: endSeconds - startSeconds
  };
}
