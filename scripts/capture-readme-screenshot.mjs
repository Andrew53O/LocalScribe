import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const appUrl = process.env.README_SCREENSHOT_APP_URL || "http://127.0.0.1:5173";
const screenshotPath = process.env.README_SCREENSHOT_OUTPUT || path.join(rootDir, "docs", "assets", "interface-screenshot.png");
const sampleYoutubeUrl = process.env.README_SCREENSHOT_YOUTUBE_URL || "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

let serverProcess;

try {
  if (!(await isAppReachable(appUrl))) {
    serverProcess = startDevServer();
    await waitForApp(appUrl);
  }

  await mkdir(path.dirname(screenshotPath), { recursive: true });

  const browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });

  await page.route("**/api/video-metadata?**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        title: "Sample YouTube video",
        durationSeconds: 5400,
        thumbnailUrl: "https://i.ytimg.com/vi/dQw4w9WgXcQ/hqdefault.jpg"
      })
    });
  });

  await page.goto(appUrl, { waitUntil: "networkidle", timeout: 60000 });
  await prepareScreenshotState(page);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  await browser.close();

  console.log(`Saved README screenshot to ${path.relative(rootDir, screenshotPath)}`);
} finally {
  stopDevServer(serverProcess);
}

async function prepareScreenshotState(page) {
  await page.getByRole("tab", { name: /youtube/i }).click({ timeout: 3000 }).catch(() => undefined);
  await page.getByLabel(/youtube url/i).fill(sampleYoutubeUrl);
  await page.getByLabel(/^start$/i).fill("00:03:00");
  await page.getByLabel(/^end$/i).fill("00:04:30");
  await page.getByLabel(/language/i).selectOption("zh-TW").catch(() => undefined);
  await page.getByLabel(/model/i).selectOption("large-v3-turbo-q8_0").catch(() => undefined);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }
  });
}

async function launchBrowser() {
  const executableCandidates = [
    process.env.PLAYWRIGHT_BROWSER_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"
  ].filter(Boolean);

  const errors = [];

  for (const executablePath of executableCandidates) {
    if (!existsSync(executablePath)) {
      continue;
    }

    try {
      return await chromium.launch({ executablePath, headless: true });
    } catch (error) {
      errors.push(`${executablePath}: ${error.message}`);
    }
  }

  for (const channel of ["msedge", "chrome"]) {
    try {
      return await chromium.launch({ channel, headless: true });
    } catch (error) {
      errors.push(`${channel}: ${error.message}`);
    }
  }

  try {
    return await chromium.launch({ headless: true });
  } catch (error) {
    errors.push(error.message);
  }

  throw new Error(`Unable to launch a browser for screenshots.\n${errors.join("\n")}\nRun: npx playwright install chromium`);
}

function startDevServer() {
  console.log("Starting dev server for screenshot capture...");
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const child = spawn(command, ["run", "dev"], {
    cwd: rootDir,
    env: process.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  child.stderr.on("data", (chunk) => process.stderr.write(chunk));

  return child;
}

function stopDevServer(child) {
  if (!child?.pid) {
    return;
  }

  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }

  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
}

async function waitForApp(url) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 60000) {
    if (await isAppReachable(url)) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 750));
  }

  throw new Error(`Timed out waiting for ${url}`);
}

async function isAppReachable(url) {
  try {
    const response = await fetch(url);
    return response.ok;
  } catch {
    return false;
  }
}
