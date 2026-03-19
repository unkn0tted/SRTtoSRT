import { BaseDirectory, remove, writeTextFile, readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { appLocalDataDir } from "@tauri-apps/api/path";
import type { AppSettings } from "./types";

const LEGACY_SETTINGS_KEY = "subtitle-duet.settings.v1";
const SETTINGS_FILE_NAME = "settings.json";

const DEFAULT_PROMPT = [
  "You are translating subtitle segments for bilingual subtitles.",
  "Return only valid JSON without markdown fences.",
  "Keep each item count and index exactly the same as the input.",
  "Subtitle style must be concise, natural, and suitable for on-screen reading.",
  "Preserve speaker labels, punctuation, bracketed cues, and meaningful line breaks.",
  "Do not add explanations or notes.",
].join("\n");

export const defaultSettings: AppSettings = {
  apiBaseUrl: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4.1-mini",
  systemPrompt: DEFAULT_PROMPT,
  extraHeaders: "",
  batchSize: 24,
  batchCharLimit: 4200,
  concurrency: 2,
  timeoutSecs: 90,
  englishMode: "preserve-source",
};

function joinPath(dir: string, fileName: string): string {
  const separator = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sanitizeNumeric(value: unknown, fallback: number, min: number, max: number): number {
  const parsed = Number(value);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return clamp(Math.round(parsed), min, max);
}

function normalizeSettings(parsed: Partial<AppSettings>): AppSettings {
  return {
    apiBaseUrl: parsed.apiBaseUrl?.trim() || defaultSettings.apiBaseUrl,
    apiKey: parsed.apiKey ?? defaultSettings.apiKey,
    model: parsed.model?.trim() || defaultSettings.model,
    systemPrompt: parsed.systemPrompt?.trim() || defaultSettings.systemPrompt,
    extraHeaders: parsed.extraHeaders ?? defaultSettings.extraHeaders,
    batchSize: sanitizeNumeric(parsed.batchSize, defaultSettings.batchSize, 1, 100),
    batchCharLimit: sanitizeNumeric(
      parsed.batchCharLimit,
      defaultSettings.batchCharLimit,
      500,
      15000,
    ),
    concurrency: sanitizeNumeric(parsed.concurrency, defaultSettings.concurrency, 1, 8),
    timeoutSecs: sanitizeNumeric(parsed.timeoutSecs, defaultSettings.timeoutSecs, 10, 600),
    englishMode:
      parsed.englishMode === "translate-to-english"
        ? "translate-to-english"
        : defaultSettings.englishMode,
  };
}

function loadLegacySettings(): AppSettings | null {
  const raw = localStorage.getItem(LEGACY_SETTINGS_KEY);

  if (!raw) {
    return null;
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return normalizeSettings(parsed);
  } catch {
    return null;
  }
}

async function loadSettingsFromFile(): Promise<AppSettings | null> {
  try {
    const raw = await readTextFile(SETTINGS_FILE_NAME, {
      baseDir: BaseDirectory.AppLocalData,
    });
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    return normalizeSettings(parsed);
  } catch {
    return null;
  }
}

export async function getLocalDataDirectory(): Promise<string> {
  return appLocalDataDir();
}

export async function getSettingsFilePath(): Promise<string> {
  return joinPath(await getLocalDataDirectory(), SETTINGS_FILE_NAME);
}

export async function openDirectoryInFileManager(path: string): Promise<void> {
  const trimmed = path.trim();

  if (!trimmed) {
    throw new Error("数据目录尚未加载完成。");
  }

  await invoke("open_directory", { path: trimmed });
}

export async function loadSettings(): Promise<AppSettings> {
  const fileSettings = await loadSettingsFromFile();

  if (fileSettings) {
    localStorage.removeItem(LEGACY_SETTINGS_KEY);
    return fileSettings;
  }

  const legacySettings = loadLegacySettings();

  if (legacySettings) {
    await saveSettings(legacySettings);
    localStorage.removeItem(LEGACY_SETTINGS_KEY);
    return legacySettings;
  }

  return { ...defaultSettings };
}

export async function saveSettings(settings: AppSettings): Promise<void> {
  const normalized = normalizeSettings(settings);

  await writeTextFile(
    SETTINGS_FILE_NAME,
    JSON.stringify(normalized, null, 2),
    {
      baseDir: BaseDirectory.AppLocalData,
    },
  );

  localStorage.removeItem(LEGACY_SETTINGS_KEY);
}

export async function resetStoredSettings(): Promise<void> {
  try {
    await remove(SETTINGS_FILE_NAME, {
      baseDir: BaseDirectory.AppLocalData,
    });
  } catch {
    // Ignore cleanup errors if the file does not exist yet.
  }

  localStorage.removeItem(LEGACY_SETTINGS_KEY);
}

export async function clearLocalData(): Promise<void> {
  await resetStoredSettings();
}

export function parseExtraHeaders(input: string): Record<string, string> {
  if (!input.trim()) {
    return {};
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("附加请求头必须是合法 JSON，例如 {\"x-api-key\":\"demo\"}");
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("附加请求头必须是 JSON 对象。");
  }

  const result: Record<string, string> = {};

  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== "string") {
      throw new Error(`请求头 ${key} 的值必须是字符串。`);
    }

    result[key] = value;
  }

  return result;
}
