import { spawn, spawnSync } from "node:child_process";

export interface RunCommandOptions {
  cwd?: string;
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
  signal?: AbortSignal;
}

export interface RunCommandResult {
  stdout: string;
  stderr: string;
}

export function runCommand(command: string, args: string[], options: RunCommandOptions = {}): Promise<RunCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      windowsHide: true
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let aborted = false;
    const timeout = options.timeoutMs
      ? setTimeout(() => {
          if (settled) {
            return;
          }

          settled = true;
          terminateProcess(child.pid);
          reject(new Error(`Command timed out: ${command}`));
        }, options.timeoutMs)
      : undefined;

    const abortHandler = () => {
      if (settled) {
        return;
      }

      aborted = true;
      terminateProcess(child.pid);
    };

    if (options.signal?.aborted) {
      abortHandler();
    } else {
      options.signal?.addEventListener("abort", abortHandler, { once: true });
    }

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      options.onStdout?.(text);
    });

    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr += text;
      options.onStderr?.(text);
    });

    child.on("error", (error) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", abortHandler);

      if (settled) {
        return;
      }

      settled = true;
      reject(error);
    });

    child.on("close", (code) => {
      if (timeout) {
        clearTimeout(timeout);
      }
      options.signal?.removeEventListener("abort", abortHandler);

      if (settled) {
        return;
      }

      settled = true;

      if (aborted || options.signal?.aborted) {
        reject(new Error(`Command cancelled: ${command}`));
        return;
      }

      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`${command} exited with code ${code}: ${stderr || stdout}`));
      }
    });
  });
}

function terminateProcess(pid: number | undefined) {
  if (!pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    // Process already exited.
  }
}
