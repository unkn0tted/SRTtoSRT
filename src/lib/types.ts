export type EnglishMode = "preserve-source" | "translate-to-english";

export interface AppSettings {
  apiBaseUrl: string;
  apiKey: string;
  model: string;
  systemPrompt: string;
  extraHeaders: string;
  batchSize: number;
  batchCharLimit: number;
  concurrency: number;
  timeoutSecs: number;
  englishMode: EnglishMode;
}

export interface SubtitleCue {
  index: number;
  start: string;
  end: string;
  trailing: string;
  text: string;
}

export interface ParsedSubtitleFile {
  id: string;
  path: string;
  name: string;
  cues: SubtitleCue[];
}

export type TaskStatus =
  | "idle"
  | "queued"
  | "running"
  | "stopped"
  | "success"
  | "error";

export interface FileTask {
  id: string;
  fileId: string;
  name: string;
  path: string;
  status: TaskStatus;
  total: number;
  completed: number;
  message: string;
  outputPath?: string;
}

export interface TranslationItem {
  index: number;
  source: string;
}

export interface TranslationSegment {
  index: number;
  source: string;
  zh: string;
  en: string;
}

export interface LogEntry {
  id: string;
  level: "info" | "error";
  message: string;
  timestamp: string;
}
