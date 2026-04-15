import { readFile } from "node:fs/promises";
import path from "node:path";

export async function loadLocalEnv(filePath = path.resolve(process.cwd(), ".env")) {
  try {
    const raw = await readFile(filePath, "utf8");

    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) {
        continue;
      }

      const separator = trimmed.indexOf("=");
      if (separator === -1) {
        continue;
      }

      const key = trimmed.slice(0, separator).trim();
      const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, "");

      if (key && process.env[key] === undefined) {
        process.env[key] = value;
      }
    }
  } catch {
    // A missing .env is fine; users can still provide environment variables directly.
  }
}
