import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type {
  AppSettings,
  ParsedSubtitleFile,
  SubtitleCue,
  TranslationSegment,
} from "./types";

const CHECKPOINT_VERSION = 1;

interface TranslationCheckpoint {
  version: number;
  sourcePath: string;
  sourceName: string;
  cueSignature: string;
  settingsSignature: string;
  translations: TranslationSegment[];
  updatedAt: string;
}

export interface LoadedCheckpoint {
  translations: TranslationSegment[];
  updatedAt: string;
}

function updateHash(hash: number, input: string): number {
  let value = hash >>> 0;

  for (let index = 0; index < input.length; index += 1) {
    value ^= input.charCodeAt(index);
    value = Math.imul(value, 16777619) >>> 0;
  }

  return value >>> 0;
}

function hashParts(parts: string[]): string {
  let hash = 2166136261;

  for (const part of parts) {
    hash = updateHash(hash, part);
    hash = updateHash(hash, "\u0000");
  }

  return hash.toString(16).padStart(8, "0");
}

function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  }

  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).sort(([left], [right]) =>
      left.localeCompare(right),
    );

    return `{${entries
      .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
      .join(",")}}`;
  }

  return JSON.stringify(value);
}

function buildCueSignature(cues: SubtitleCue[]): string {
  return hashParts(
    cues.map((cue) =>
      [
        String(cue.index),
        cue.start,
        cue.end,
        cue.trailing,
        cue.text,
      ].join("\u001f"),
    ),
  );
}

function buildSettingsSignature(
  settings: AppSettings,
  extraHeaders: Record<string, string>,
): string {
  return hashParts([
    stableStringify({
      apiBaseUrl: settings.apiBaseUrl.trim(),
      model: settings.model.trim(),
      systemPrompt: settings.systemPrompt.trim(),
      englishMode: settings.englishMode,
      extraHeaders,
    }),
  ]);
}

function isValidTranslationSegment(
  segment: TranslationSegment,
  expectedIndexes: Set<number>,
): boolean {
  return (
    Number.isInteger(segment.index) &&
    expectedIndexes.has(segment.index) &&
    typeof segment.source === "string" &&
    typeof segment.zh === "string" &&
    typeof segment.en === "string" &&
    segment.zh.trim().length > 0 &&
    segment.en.trim().length > 0
  );
}

export async function loadTranslationCheckpoint(
  checkpointPath: string,
  file: ParsedSubtitleFile,
  settings: AppSettings,
  extraHeaders: Record<string, string>,
): Promise<LoadedCheckpoint | null> {
  let raw: string;

  try {
    raw = await readTextFile(checkpointPath);
  } catch {
    return null;
  }

  let parsed: TranslationCheckpoint;

  try {
    parsed = JSON.parse(raw) as TranslationCheckpoint;
  } catch {
    return null;
  }

  if (
    !parsed ||
    parsed.version !== CHECKPOINT_VERSION ||
    parsed.sourcePath !== file.path ||
    parsed.sourceName !== file.name ||
    parsed.cueSignature !== buildCueSignature(file.cues) ||
    parsed.settingsSignature !== buildSettingsSignature(settings, extraHeaders) ||
    !Array.isArray(parsed.translations)
  ) {
    return null;
  }

  const expectedIndexes = new Set(file.cues.map((cue) => cue.index));
  const deduped = new Map<number, TranslationSegment>();

  for (const segment of parsed.translations) {
    if (!segment || typeof segment !== "object") {
      continue;
    }

    const normalized = segment as TranslationSegment;

    if (!isValidTranslationSegment(normalized, expectedIndexes)) {
      continue;
    }

    deduped.set(normalized.index, {
      index: normalized.index,
      source: normalized.source,
      zh: normalized.zh,
      en: normalized.en,
    });
  }

  return {
    translations: Array.from(deduped.values()).sort((left, right) => left.index - right.index),
    updatedAt: parsed.updatedAt,
  };
}

export async function saveTranslationCheckpoint(
  checkpointPath: string,
  file: ParsedSubtitleFile,
  settings: AppSettings,
  extraHeaders: Record<string, string>,
  translations: TranslationSegment[],
): Promise<void> {
  const checkpoint: TranslationCheckpoint = {
    version: CHECKPOINT_VERSION,
    sourcePath: file.path,
    sourceName: file.name,
    cueSignature: buildCueSignature(file.cues),
    settingsSignature: buildSettingsSignature(settings, extraHeaders),
    translations: [...translations].sort((left, right) => left.index - right.index),
    updatedAt: new Date().toISOString(),
  };

  await writeTextFile(checkpointPath, JSON.stringify(checkpoint, null, 2));
}
