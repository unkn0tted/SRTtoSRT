import type { AppSettings } from "./types";

const SETTINGS_KEY = "subtitle-duet.settings.v1";

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

export function loadSettings(): AppSettings {
  const raw = localStorage.getItem(SETTINGS_KEY);

  if (!raw) {
    return { ...defaultSettings };
  }

  try {
    const parsed = JSON.parse(raw) as Partial<AppSettings>;

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
  } catch {
    return { ...defaultSettings };
  }
}

export function saveSettings(settings: AppSettings): void {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
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
