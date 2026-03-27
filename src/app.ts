import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { loadTranslationCheckpoint, saveTranslationCheckpoint } from "./lib/checkpoint";
import { describeError } from "./lib/errors";
import {
  closeWindow,
  minimizeWindow,
  openDirectoryInFileManager,
  toggleMaximizeWindow,
} from "./lib/native/desktop";
import { translateCueBatch } from "./lib/openai";
import { buildBatches, buildSrtContent, parseSrt } from "./lib/srt";
import {
  clearLocalData,
  defaultSettings,
  getLocalDataDirectory,
  getSettingsFilePath,
  loadSettings,
  parseExtraHeaders,
  resetStoredSettings,
  saveSettings,
} from "./lib/settings";
import { mapLimit } from "./lib/tasks";
import type {
  AppSettings,
  FileTask,
  LogEntry,
  ParsedSubtitleFile,
  SubtitleCue,
  TranslationSegment,
} from "./lib/types";

type RunPhase = "idle" | "running" | "stopping";

interface ActiveRun {
  settings: AppSettings;
  extraHeaders: Record<string, string>;
  outputDirectory: string;
}

interface AppState {
  settings: AppSettings;
  activeRun: ActiveRun | null;
  files: ParsedSubtitleFile[];
  tasks: FileTask[];
  outputDirectory: string;
  localDataDirectory: string;
  settingsFilePath: string;
  logs: LogEntry[];
  runPhase: RunPhase;
}

interface Refs {
  titlebarMinimizeButton: HTMLButtonElement;
  titlebarMaximizeButton: HTMLButtonElement;
  titlebarCloseButton: HTMLButtonElement;
  form: HTMLFormElement;
  runNote: HTMLDivElement;
  filesHint: HTMLDivElement;
  outputPath: HTMLDivElement;
  statusBadge: HTMLDivElement;
  stats: HTMLDivElement;
  fileList: HTMLDivElement;
  logList: HTMLDivElement;
  localDataPath: HTMLDivElement;
  settingsPath: HTMLDivElement;
  selectFilesButton: HTMLButtonElement;
  clearFilesButton: HTMLButtonElement;
  chooseOutputButton: HTMLButtonElement;
  openLocalDataButton: HTMLButtonElement;
  resetSettingsButton: HTMLButtonElement;
  clearLocalDataButton: HTMLButtonElement;
  startButton: HTMLButtonElement;
  stopButton: HTMLButtonElement;
}

const rootId = "subtitle-duet-shell";

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createInitialState(): AppState {
  return {
    settings: { ...defaultSettings },
    activeRun: null,
    files: [],
    tasks: [],
    outputDirectory: "",
    localDataDirectory: "",
    settingsFilePath: "",
    logs: [
      {
        id: uid("log"),
        level: "info",
        message: "等待选择 SRT 文件。",
        timestamp: new Date().toLocaleTimeString(),
      },
    ],
    runPhase: "idle",
  };
}

function renderShell(root: HTMLDivElement): void {
  root.innerHTML = `
    <div class="shell" id="${rootId}">
      <header class="titlebar">
        <div class="titlebar-drag" data-tauri-drag-region>
          <div class="titlebar-brand">
            <span class="titlebar-badge">Subtitle Duet</span>
            <span class="titlebar-caption">Borderless Desktop Translator</span>
          </div>
        </div>

        <div class="titlebar-controls">
          <button
            class="titlebar-button"
            id="titlebar-minimize-button"
            type="button"
            aria-label="最小化窗口"
            title="最小化"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 8.5h10v-1H3z" fill="currentColor" />
            </svg>
          </button>
          <button
            class="titlebar-button"
            id="titlebar-maximize-button"
            type="button"
            aria-label="最大化或还原窗口"
            title="最大化或还原"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path d="M3 3h10v10H3zm1 1v8h8V4z" fill="currentColor" />
            </svg>
          </button>
          <button
            class="titlebar-button close"
            id="titlebar-close-button"
            type="button"
            aria-label="关闭窗口"
            title="关闭"
          >
            <svg viewBox="0 0 16 16" aria-hidden="true">
              <path
                d="M4.35 3.65 8 7.29l3.65-3.64.7.7L8.71 8l3.64 3.65-.7.7L8 8.71l-3.65 3.64-.7-.7L7.29 8 3.65 4.35z"
                fill="currentColor"
              />
            </svg>
          </button>
        </div>
      </header>

      <section class="hero">
        <div>
          <p class="eyebrow">Tauri / SRT-only / OpenAI-compatible API</p>
          <h1>Subtitle Duet</h1>
          <p class="hero-copy">
            批量导入 SRT，调用你自定义的 OpenAI 兼容接口，导出上中文、下英文的双语字幕。
          </p>
        </div>
        <div class="hero-badges">
          <div class="hero-chip">跨平台桌面</div>
          <div class="hero-chip">本地文件处理</div>
          <div class="hero-chip">批量任务</div>
        </div>
      </section>

      <section class="workspace">
        <aside class="panel panel-settings">
          <div class="panel-title-row">
            <div>
              <p class="panel-kicker">连接配置</p>
              <h2>模型与接口</h2>
            </div>
            <div class="status-badge" id="status-badge"></div>
          </div>
          <div class="run-note" id="run-note"></div>

          <form id="settings-form" class="settings-form">
            <label class="field">
              <span>API Base URL</span>
              <input name="apiBaseUrl" placeholder="https://api.openai.com/v1" />
            </label>

            <label class="field">
              <span>API Key</span>
              <input name="apiKey" type="password" placeholder="sk-..." />
            </label>

            <label class="field">
              <span>Model</span>
              <input name="model" placeholder="gpt-4.1-mini" />
            </label>

            <div class="field-grid">
              <label class="field">
                <span>单批条数</span>
                <input name="batchSize" type="number" min="1" max="100" />
              </label>
              <label class="field">
                <span>字符上限</span>
                <input name="batchCharLimit" type="number" min="500" max="15000" />
              </label>
            </div>

            <div class="field-grid">
              <label class="field">
                <span>并发数</span>
                <input name="concurrency" type="number" min="1" max="8" />
              </label>
              <label class="field">
                <span>超时秒数</span>
                <input name="timeoutSecs" type="number" min="10" max="600" />
              </label>
            </div>

            <fieldset class="field mode-field">
              <legend>英文行模式</legend>
              <label class="choice">
                <input type="radio" name="englishMode" value="preserve-source" />
                <span>保留原文</span>
              </label>
              <label class="choice">
                <input type="radio" name="englishMode" value="translate-to-english" />
                <span>强制输出英文</span>
              </label>
            </fieldset>

            <label class="field">
              <span>附加请求头(JSON，可选)</span>
              <textarea
                name="extraHeaders"
                rows="4"
                placeholder='{"x-api-key":"demo"}'
              ></textarea>
            </label>

            <label class="field">
              <span>System Prompt</span>
              <textarea name="systemPrompt" rows="9"></textarea>
            </label>
          </form>

          <section class="local-data-card">
            <div class="panel-title-row">
              <div>
                <p class="panel-kicker">本地数据</p>
                <h2>设置与清理</h2>
              </div>
            </div>

            <div class="summary-card local-data-summary">
              <span class="summary-label">数据目录</span>
              <div class="summary-value" id="local-data-path">读取中...</div>
              <span class="summary-label">设置文件</span>
              <div class="summary-value" id="settings-path">读取中...</div>
              <p class="data-note">
                当前版本会把本地设置保存到上面的 <code>settings.json</code>。点击“清理本地数据”会删除这个文件，并清理旧版遗留的隐藏设置。
              </p>
              <div class="action-row local-data-actions">
                <button class="button ghost" id="open-local-data-button" type="button">打开数据目录</button>
                <button class="button ghost" id="reset-settings-button" type="button">重置所有本地设置</button>
                <button class="button ghost" id="clear-local-data-button" type="button">一键清理本地数据</button>
              </div>
            </div>
          </section>
        </aside>

        <main class="panel panel-main">
          <div class="panel-title-row panel-main-title">
            <div>
              <p class="panel-kicker">批量任务</p>
              <h2>文件队列与导出</h2>
            </div>
            <div class="action-row">
              <button class="button ghost" id="clear-files-button" type="button">清空列表</button>
              <button class="button secondary" id="select-files-button" type="button">添加 SRT 文件</button>
              <button class="button ghost danger" id="stop-button" type="button">停止并保存进度</button>
              <button class="button primary" id="start-button" type="button">开始翻译</button>
            </div>
          </div>

          <div class="summary-grid">
            <div class="summary-card">
              <span class="summary-label">输出目录</span>
              <div class="summary-value" id="output-path"></div>
              <button class="button tiny" id="choose-output-button" type="button">选择目录</button>
            </div>
            <div class="summary-card">
              <span class="summary-label">队列概览</span>
              <div class="summary-value" id="stats"></div>
            </div>
          </div>

          <div class="files-hint" id="files-hint"></div>
          <div class="file-list" id="file-list"></div>

          <section class="logs">
            <div class="logs-title-row">
              <p class="panel-kicker">运行日志</p>
            </div>
            <div class="log-list" id="log-list"></div>
          </section>
        </main>
      </section>
    </div>
  `;
}

function basename(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] || filePath;
}

function removeExtension(name: string): string {
  return name.replace(/\.[^.]+$/, "");
}

function joinPath(dir: string, fileName: string): string {
  const separator = dir.includes("\\") ? "\\" : "/";
  return `${dir.replace(/[\\/]+$/, "")}${separator}${fileName}`;
}

async function wait(ms: number, shouldStop?: () => boolean): Promise<void> {
  const slice = 150;
  let remaining = ms;

  while (remaining > 0) {
    if (shouldStop?.()) {
      return;
    }

    await new Promise<void>((resolve) => {
      window.setTimeout(resolve, Math.min(slice, remaining));
    });

    remaining -= Math.min(slice, remaining);
  }
}

function formatCueRange(batch: SubtitleCue[]): string {
  const startIndex = batch[0]?.index;
  const endIndex = batch[batch.length - 1]?.index;

  return typeof startIndex === "number" && typeof endIndex === "number"
    ? `字幕 ${startIndex}-${endIndex}`
    : "字幕范围未知";
}

function isPermanentBatchError(message: string): boolean {
  return [
    "API Base URL 不能为空",
    "Model 不能为空",
    "Invalid Authorization header",
    "Invalid header name",
    "Invalid header value",
    "HTTP 400",
    "HTTP 401",
    "HTTP 403",
  ].some((keyword) => message.includes(keyword));
}

function isRetryableBatchError(message: string): boolean {
  const normalized = message.toLowerCase();

  return (
    normalized.includes("http request failed") ||
    normalized.includes("timed out") ||
    normalized.includes("timeout") ||
    normalized.includes("connection") ||
    normalized.includes("dns") ||
    normalized.includes("429") ||
    normalized.includes("500") ||
    normalized.includes("502") ||
    normalized.includes("503") ||
    normalized.includes("504") ||
    message.includes("缺少中文翻译") ||
    message.includes("缺少英文行") ||
    message.includes("模型没有返回合法 JSON") ||
    message.includes("模型返回 JSON") ||
    message.includes("无法从模型响应中提取文本内容") ||
    message.includes("模型响应")
  );
}

class StopRequestedError extends Error {
  constructor() {
    super("当前任务已按请求停止。");
    this.name = "StopRequestedError";
  }
}

function isBusy(state: AppState): boolean {
  return state.runPhase !== "idle";
}

function isStopRequested(state: AppState): boolean {
  return state.runPhase === "stopping";
}

function hasUnfinishedTasks(state: AppState): boolean {
  return state.tasks.some((task) => task.status !== "success");
}

function hasStartedTasks(state: AppState): boolean {
  return state.tasks.some(
    (task) =>
      task.status === "success" ||
      task.status === "error" ||
      task.status === "stopped" ||
      task.completed > 0,
  );
}

function getStartButtonLabel(state: AppState): string {
  if (state.tasks.length === 0) {
    return "开始翻译";
  }

  if (!hasUnfinishedTasks(state)) {
    return "重新翻译全部文件";
  }

  return hasStartedTasks(state) ? "继续未完成任务" : "开始翻译";
}

function getRunNote(state: AppState): string {
  const activeModel = state.activeRun?.settings.model;
  const activeRunLabel = activeModel ? `${activeModel} 这组参数` : "这组参数";

  if (state.runPhase === "stopping") {
    return `正在等待当前批次收尾并保存断点。当前仍使用 ${activeRunLabel}；你现在修改的内容会在下一次继续时生效。`;
  }

  if (state.runPhase === "running") {
    return `当前运行使用 ${activeRunLabel}。你现在修改的内容只会影响下一次开始或继续。`;
  }

  if (!hasUnfinishedTasks(state) && state.tasks.length > 0) {
    return "当前队列已经完成。如果要用新参数重跑这一批文件，可以直接再次开始。";
  }

  if (hasStartedTasks(state)) {
    return "当前队列里有未完成文件。点击“继续未完成任务”会跳过已完成文件，只处理剩余文件；如果你改了模型、Prompt 或英文模式，旧断点可能会从头开始。";
  }

  return "建议先用 2-3 个样本文件试跑，确认 prompt、模型和并发设置后，再翻整批任务。";
}

function formatTaskStatus(status: FileTask["status"]): string {
  switch (status) {
    case "idle":
      return "待处理";
    case "queued":
      return "排队中";
    case "running":
      return "运行中";
    case "stopped":
      return "已暂停";
    case "success":
      return "已完成";
    case "error":
      return "失败";
    default:
      return status;
  }
}

async function translateCueBatchWithRecovery(
  batch: SubtitleCue[],
  settings: AppSettings,
  extraHeaders: Record<string, string>,
  note: (message: string) => void,
  shouldStop: () => boolean,
): Promise<TranslationSegment[]> {
  const maxAttempts = batch.length === 1 ? 3 : 2;
  const retryDelays = [1200, 2400];
  let lastError: unknown;
  let lastMessage = "未知错误";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (shouldStop()) {
      throw new StopRequestedError();
    }

    try {
      return await translateCueBatch(batch, settings, extraHeaders);
    } catch (error) {
      lastError = error;
      lastMessage = describeError(error);

      if (shouldStop()) {
        throw new StopRequestedError();
      }

      if (attempt < maxAttempts && isRetryableBatchError(lastMessage)) {
        note(
          `${formatCueRange(batch)} 第 ${attempt + 1}/${maxAttempts} 次尝试前重试：${lastMessage}`,
        );
        await wait(retryDelays[Math.min(attempt - 1, retryDelays.length - 1)], shouldStop);
        continue;
      }

      break;
    }
  }

  if (shouldStop()) {
    throw new StopRequestedError();
  }

  if (batch.length > 1 && !isPermanentBatchError(lastMessage)) {
    const mid = Math.ceil(batch.length / 2);
    const left = batch.slice(0, mid);
    const right = batch.slice(mid);

    note(
      `${formatCueRange(batch)} 仍然失败，自动拆分为 ${left.length}+${right.length} 条继续重试。`,
    );

    const leftResult = await translateCueBatchWithRecovery(
      left,
      settings,
      extraHeaders,
      note,
      shouldStop,
    );
    const rightResult = await translateCueBatchWithRecovery(
      right,
      settings,
      extraHeaders,
      note,
      shouldStop,
    );

    return [...leftResult, ...rightResult];
  }

  throw (lastError instanceof Error ? lastError : new Error(lastMessage));
}

function createTask(file: ParsedSubtitleFile): FileTask {
  return {
    id: uid("task"),
    fileId: file.id,
    name: file.name,
    path: file.path,
    status: "idle",
    total: file.cues.length,
    completed: 0,
    message: "待处理",
  };
}

function pushLog(state: AppState, level: LogEntry["level"], message: string): void {
  state.logs = [
    {
      id: uid("log"),
      level,
      message,
      timestamp: new Date().toLocaleTimeString(),
    },
    ...state.logs,
  ].slice(0, 12);
}

function updateTask(state: AppState, fileId: string, patch: Partial<FileTask>): void {
  state.tasks = state.tasks.map((task) =>
    task.fileId === fileId
      ? {
          ...task,
          ...patch,
        }
      : task,
  );
}

function escapeHtml(input: string): string {
  return input
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderDynamic(state: AppState, refs: Refs): void {
  const successCount = state.tasks.filter((task) => task.status === "success").length;
  const errorCount = state.tasks.filter((task) => task.status === "error").length;
  const stoppedCount = state.tasks.filter((task) => task.status === "stopped").length;
  const totalCount = state.tasks.length;
  const doneLines = state.tasks.reduce((sum, task) => sum + task.completed, 0);
  const totalLines = state.tasks.reduce((sum, task) => sum + task.total, 0);

  refs.stats.textContent =
    totalCount === 0
      ? "尚未添加文件"
      : `${totalCount} 个文件 / ${doneLines}/${totalLines} 条字幕 / 成功 ${successCount} / 暂停 ${stoppedCount} / 失败 ${errorCount}`;

  refs.outputPath.textContent = state.outputDirectory || "未选择，开始前必须指定";
  refs.localDataPath.textContent = state.localDataDirectory || "读取中...";
  refs.settingsPath.textContent = state.settingsFilePath || "读取中...";
  refs.runNote.textContent = getRunNote(state);
  refs.filesHint.textContent =
    state.files.length === 0
      ? "先添加 SRT 文件，再决定是开始新一轮还是继续未完成任务。"
      : `已载入 ${state.files.length} 个文件。当前仅支持 SRT，输出文件名会追加 .bilingual.srt。`;

  refs.statusBadge.textContent =
    state.runPhase === "running"
      ? "运行中"
      : state.runPhase === "stopping"
        ? "停止中"
        : "就绪";
  refs.statusBadge.dataset.status = state.runPhase;
  refs.startButton.textContent = getStartButtonLabel(state);
  refs.stopButton.textContent =
    state.runPhase === "stopping" ? "停止中，等待当前批次收尾" : "停止并保存进度";

  refs.fileList.innerHTML =
    state.tasks.length === 0
      ? `<div class="empty-card">文件列表为空。点击“添加 SRT 文件”开始。</div>`
      : state.tasks
          .map((task) => {
            const progress = task.total === 0 ? 0 : Math.round((task.completed / task.total) * 100);

            return `
              <article class="task-card" data-status="${task.status}">
                <div class="task-head">
                  <div>
                    <h3>${escapeHtml(task.name)}</h3>
                    <p class="task-path">${escapeHtml(task.path)}</p>
                  </div>
                  <div class="task-meta">
                    <span class="pill">${escapeHtml(formatTaskStatus(task.status))}</span>
                    <span>${task.completed}/${task.total}</span>
                  </div>
                </div>
                <div class="progress-track">
                  <div class="progress-fill" style="width:${progress}%"></div>
                </div>
                <p class="task-message">${escapeHtml(task.message)}</p>
                ${
                  task.outputPath
                    ? `<p class="task-output">${escapeHtml(task.outputPath)}</p>`
                    : ""
                }
              </article>
            `;
          })
          .join("");

  refs.logList.innerHTML = state.logs
    .map(
      (entry) => `
        <div class="log-entry" data-level="${entry.level}">
          <span>${entry.timestamp}</span>
          <p>${escapeHtml(entry.message)}</p>
        </div>
      `,
    )
    .join("");

  refs.selectFilesButton.disabled = isBusy(state);
  refs.clearFilesButton.disabled = isBusy(state) || state.files.length === 0;
  refs.chooseOutputButton.disabled = isBusy(state);
  refs.openLocalDataButton.disabled = !state.localDataDirectory;
  refs.resetSettingsButton.disabled = isBusy(state);
  refs.clearLocalDataButton.disabled = isBusy(state);
  refs.startButton.disabled = isBusy(state) || state.files.length === 0;
  refs.stopButton.disabled = state.runPhase !== "running";
}

function syncFormValues(refs: Refs, settings: AppSettings): void {
  const formData: Record<string, string> = {
    apiBaseUrl: settings.apiBaseUrl,
    apiKey: settings.apiKey,
    model: settings.model,
    systemPrompt: settings.systemPrompt,
    extraHeaders: settings.extraHeaders,
    batchSize: String(settings.batchSize),
    batchCharLimit: String(settings.batchCharLimit),
    concurrency: String(settings.concurrency),
    timeoutSecs: String(settings.timeoutSecs),
  };

  Object.entries(formData).forEach(([name, value]) => {
    const field = refs.form.elements.namedItem(name);

    if (field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) {
      field.value = value;
    }
  });

  const modeField = refs.form.elements.namedItem("englishMode");

  if (modeField && "value" in modeField) {
    modeField.value = settings.englishMode;
  }
}

function readSettingsFromForm(form: HTMLFormElement, current: AppSettings): AppSettings {
  const getValue = (name: string): string => {
    const field = form.elements.namedItem(name);

    if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement)) {
      return "";
    }

    return field.value;
  };

  const englishModeNode = form.elements.namedItem("englishMode");
  const englishModeValue =
    englishModeNode && "value" in englishModeNode ? String(englishModeNode.value) : "";
  const englishMode =
    englishModeValue === "translate-to-english"
      ? "translate-to-english"
      : "preserve-source";

  return {
    apiBaseUrl: getValue("apiBaseUrl").trim(),
    apiKey: getValue("apiKey").trim(),
    model: getValue("model").trim(),
    systemPrompt: getValue("systemPrompt").trim() || defaultSettings.systemPrompt,
    extraHeaders: getValue("extraHeaders"),
    batchSize: Number(getValue("batchSize")) || current.batchSize,
    batchCharLimit: Number(getValue("batchCharLimit")) || current.batchCharLimit,
    concurrency: Number(getValue("concurrency")) || current.concurrency,
    timeoutSecs: Number(getValue("timeoutSecs")) || current.timeoutSecs,
    englishMode,
  };
}

async function chooseSubtitleFiles(state: AppState, refs: Refs): Promise<void> {
  const selection = await open({
    multiple: true,
    directory: false,
    filters: [
      {
        name: "SubRip Subtitle",
        extensions: ["srt"],
      },
    ],
  });

  const selectedPaths = Array.isArray(selection)
    ? selection.filter((item): item is string => typeof item === "string")
    : typeof selection === "string"
      ? [selection]
      : [];

  if (selectedPaths.length === 0) {
    return;
  }

  const knownPaths = new Set(state.files.map((file) => file.path));
  let addedCount = 0;

  for (const filePath of selectedPaths) {
    if (knownPaths.has(filePath)) {
      continue;
    }

    const raw = await readTextFile(filePath);
    const cues = parseSrt(raw);

    if (cues.length === 0) {
      pushLog(state, "error", `${basename(filePath)} 解析失败：没有读到有效 SRT 条目。`);
      continue;
    }

    const file: ParsedSubtitleFile = {
      id: uid("file"),
      path: filePath,
      name: basename(filePath),
      cues,
    };

    state.files.push(file);
    state.tasks.push(createTask(file));
    knownPaths.add(filePath);
    addedCount += 1;
  }

  if (addedCount > 0) {
    pushLog(state, "info", `已加入 ${addedCount} 个文件。`);
  }

  renderDynamic(state, refs);
}

async function chooseOutputDirectory(state: AppState, refs: Refs): Promise<void> {
  const selection = await open({
    directory: true,
    multiple: false,
    recursive: true,
  });

  if (typeof selection !== "string" || !selection) {
    return;
  }

  state.outputDirectory = selection;
  pushLog(state, "info", `输出目录已更新为 ${selection}`);
  renderDynamic(state, refs);
}

function clearFiles(state: AppState, refs: Refs): void {
  state.files = [];
  state.tasks = [];
  pushLog(state, "info", "已清空文件列表。");
  renderDynamic(state, refs);
}

function cloneSettings(settings: AppSettings): AppSettings {
  return { ...settings };
}

function validateBeforeRun(
  settings: AppSettings,
  outputDirectory: string,
): Record<string, string> {
  if (!settings.apiBaseUrl.trim()) {
    throw new Error("API Base URL 不能为空。");
  }

  if (!settings.model.trim()) {
    throw new Error("Model 不能为空。");
  }

  if (!outputDirectory.trim()) {
    throw new Error("请先选择输出目录。");
  }

  return parseExtraHeaders(settings.extraHeaders);
}

function createActiveRun(state: AppState): ActiveRun {
  const settings = cloneSettings(state.settings);
  const outputDirectory = state.outputDirectory.trim();
  const extraHeaders = validateBeforeRun(settings, outputDirectory);

  return {
    settings,
    extraHeaders,
    outputDirectory,
  };
}

function getRunPlan(state: AppState): {
  filesToProcess: ParsedSubtitleFile[];
  rerunAll: boolean;
  skippedCount: number;
  resumeMode: boolean;
} {
  const unfinishedIds = new Set(
    state.tasks.filter((task) => task.status !== "success").map((task) => task.fileId),
  );

  if (unfinishedIds.size === 0) {
    return {
      filesToProcess: [...state.files],
      rerunAll: true,
      skippedCount: 0,
      resumeMode: false,
    };
  }

  return {
    filesToProcess: state.files.filter((file) => unfinishedIds.has(file.id)),
    rerunAll: false,
    skippedCount: state.files.length - unfinishedIds.size,
    resumeMode: hasStartedTasks(state),
  };
}

function prepareTasksForRun(state: AppState, rerunAll: boolean): void {
  state.tasks = state.tasks.map((task) => {
    if (rerunAll) {
      return {
        ...task,
        status: "queued",
        completed: 0,
        message: "排队中",
        outputPath: undefined,
      };
    }

    if (task.status === "success") {
      return {
        ...task,
        message: "已完成，本轮继续时跳过",
      };
    }

    return {
      ...task,
      status: "queued",
      message: task.completed > 0 ? `排队继续 ${task.completed}/${task.total}` : "排队中",
      outputPath: undefined,
    };
  });
}

function markPendingTasksStopped(state: AppState): void {
  state.tasks = state.tasks.map((task) => {
    if (task.status === "queued") {
      return {
        ...task,
        status: "stopped",
        message: task.completed > 0 ? `已暂停，保留 ${task.completed}/${task.total}` : "未开始，等待继续",
      };
    }

    if (task.status === "running") {
      return {
        ...task,
        status: "stopped",
        message: task.completed > 0 ? `已暂停，保留 ${task.completed}/${task.total}` : "已暂停，等待继续",
      };
    }

    return task;
  });
}

function requestSoftStop(state: AppState, refs: Refs): void {
  if (state.runPhase !== "running") {
    return;
  }

  state.runPhase = "stopping";
  pushLog(state, "info", "已请求停止。当前批次收尾后会保存断点并暂停剩余任务。");
  renderDynamic(state, refs);
}

async function translateFile(
  file: ParsedSubtitleFile,
  state: AppState,
  refs: Refs,
  run: ActiveRun,
): Promise<void> {
  if (isStopRequested(state)) {
    throw new StopRequestedError();
  }

  const outputFileName = `${removeExtension(file.name)}.bilingual.srt`;
  const outputPath = joinPath(run.outputDirectory, outputFileName);
  const checkpointPath = joinPath(
    run.outputDirectory,
    `${removeExtension(file.name)}.bilingual.checkpoint.json`,
  );
  const rememberedCompleted =
    state.tasks.find((task) => task.fileId === file.id)?.completed ?? 0;
  const batches = buildBatches(file.cues, run.settings.batchSize, run.settings.batchCharLimit);
  const checkpoint = await loadTranslationCheckpoint(checkpointPath, file, run.settings, run.extraHeaders);
  const translationsByIndex = new Map<number, TranslationSegment>();

  for (const translation of checkpoint?.translations ?? []) {
    translationsByIndex.set(translation.index, translation);
  }

  const restoredCount = translationsByIndex.size;

  updateTask(state, file.id, {
    status: "running",
    completed: restoredCount,
    total: file.cues.length,
    message:
      restoredCount > 0
        ? `已从断点恢复 ${restoredCount}/${file.cues.length}`
        : `已拆分为 ${batches.length} 个批次`,
    outputPath: undefined,
  });
  renderDynamic(state, refs);

  if (checkpoint && restoredCount > 0) {
    pushLog(
      state,
      "info",
      `${file.name} 已恢复断点 ${restoredCount}/${file.cues.length}，继续补剩余字幕。`,
    );
    renderDynamic(state, refs);
  } else if (rememberedCompleted > 0) {
    pushLog(
      state,
      "info",
      `${file.name} 的旧断点在当前输出目录或当前输出内容参数下不可用，本次会从头开始重跑。`,
    );
    renderDynamic(state, refs);
  }

  const pendingBatches = batches
    .map((batch, originalIndex) => ({
      originalIndex,
      cues: batch.filter((cue) => !translationsByIndex.has(cue.index)),
    }))
    .filter((entry) => entry.cues.length > 0);

  let checkpointWrite = Promise.resolve();
  const persistCheckpoint = async (): Promise<void> => {
    const snapshot = Array.from(translationsByIndex.values()).sort(
      (left, right) => left.index - right.index,
    );
    checkpointWrite = checkpointWrite.then(() =>
      saveTranslationCheckpoint(
        checkpointPath,
        file,
        run.settings,
        run.extraHeaders,
        snapshot,
      ),
    );

    await checkpointWrite;
  };

  await mapLimit(
    pendingBatches,
    run.settings.concurrency,
    async ({ originalIndex, cues }) => {
      if (isStopRequested(state)) {
        return [];
      }

      try {
        const result = await translateCueBatchWithRecovery(
          cues,
          run.settings,
          run.extraHeaders,
          (message) => {
            pushLog(
              state,
              "info",
              `${file.name} 批次 ${originalIndex + 1}/${batches.length}：${message}`,
            );
            renderDynamic(state, refs);
          },
          () => isStopRequested(state),
        );

        if (result.length === 0) {
          return result;
        }

        for (const translation of result) {
          translationsByIndex.set(translation.index, translation);
        }

        await persistCheckpoint();

        updateTask(state, file.id, {
          status: "running",
          completed: translationsByIndex.size,
          message: `已完成 ${translationsByIndex.size}/${file.cues.length}（自动保存断点）`,
        });
        renderDynamic(state, refs);

        return result;
      } catch (error) {
        if (error instanceof StopRequestedError) {
          return [];
        }

        throw new Error(
          `批次 ${originalIndex + 1}/${batches.length}（${formatCueRange(cues)}）失败：${describeError(error)}`,
        );
      }
    },
    () => isStopRequested(state),
  );

  await checkpointWrite;

  if (isStopRequested(state) && translationsByIndex.size < file.cues.length) {
    updateTask(state, file.id, {
      status: "stopped",
      completed: translationsByIndex.size,
      message: `已停止，已保存 ${translationsByIndex.size}/${file.cues.length}，可继续`,
      outputPath: undefined,
    });
    pushLog(
      state,
      "info",
      `${file.name} 已停止，已保存 ${translationsByIndex.size}/${file.cues.length} 条断点。`,
    );
    renderDynamic(state, refs);
    throw new StopRequestedError();
  }

  const translations = file.cues.map((cue) => {
    const translation = translationsByIndex.get(cue.index);

    if (!translation) {
      throw new Error(`字幕 ${cue.index} 缺少已保存的翻译结果。`);
    }

    return translation;
  });
  const outputContent = buildSrtContent(file.cues, translations);

  await writeTextFile(outputPath, outputContent);

  try {
    await remove(checkpointPath);
  } catch {
    // Ignore cleanup errors so a finished export is still considered successful.
  }

  updateTask(state, file.id, {
    status: "success",
    completed: file.cues.length,
    message: "导出完成",
    outputPath,
  });
  pushLog(state, "info", `${file.name} 已导出到 ${outputPath}`);
  renderDynamic(state, refs);
}

async function startBatchRun(state: AppState, refs: Refs): Promise<void> {
  let run: ActiveRun;

  try {
    run = createActiveRun(state);
  } catch (error) {
    const message = describeError(error, "配置校验失败。");
    pushLog(state, "error", message);
    renderDynamic(state, refs);
    throw error;
  }

  const { filesToProcess, rerunAll, skippedCount, resumeMode } = getRunPlan(state);

  state.activeRun = run;
  state.runPhase = "running";
  prepareTasksForRun(state, rerunAll);
  pushLog(
    state,
    "info",
    rerunAll
      ? `开始重新翻译，共 ${filesToProcess.length} 个文件。`
      : resumeMode
        ? `继续未完成任务，共 ${filesToProcess.length} 个文件${
            skippedCount > 0 ? `，跳过 ${skippedCount} 个已完成文件` : ""
          }。`
        : `开始批量翻译，共 ${filesToProcess.length} 个文件。`,
  );
  renderDynamic(state, refs);

  try {
    for (const file of filesToProcess) {
      if (isStopRequested(state)) {
        break;
      }

      try {
        await translateFile(file, state, refs, run);
      } catch (error) {
        if (error instanceof StopRequestedError) {
          break;
        }

        const task = state.tasks.find((item) => item.fileId === file.id);
        const resumeHint =
          task && task.completed > 0
            ? ` 已保存 ${task.completed}/${task.total} 条断点，重新点击“继续未完成任务”可继续。`
            : "";
        const message = `${describeError(error)}${resumeHint}`;
        updateTask(state, file.id, {
          status: "error",
          message,
        });
        pushLog(state, "error", `${file.name} 失败：${message}`);
        renderDynamic(state, refs);
      }
    }

    if (isStopRequested(state) && hasUnfinishedTasks(state)) {
      markPendingTasksStopped(state);
      pushLog(state, "info", "本轮已暂停。未完成文件会保留在列表里，调整参数后可继续。");
    } else {
      pushLog(state, "info", "本轮任务结束。");
    }
  } finally {
    state.activeRun = null;
    state.runPhase = "idle";
    renderDynamic(state, refs);
  }
}

async function hydratePersistence(state: AppState, refs: Refs): Promise<void> {
  try {
    const [settings, localDataDirectory, settingsFilePath] = await Promise.all([
      loadSettings(),
      getLocalDataDirectory(),
      getSettingsFilePath(),
    ]);

    state.settings = settings;
    state.localDataDirectory = localDataDirectory;
    state.settingsFilePath = settingsFilePath;
    syncFormValues(refs, state.settings);
    renderDynamic(state, refs);
  } catch (error) {
    pushLog(state, "error", describeError(error, "读取本地设置失败。"));
    renderDynamic(state, refs);
  }
}

function persistSettings(state: AppState, refs: Refs): void {
  void saveSettings(state.settings).catch((error) => {
    pushLog(state, "error", describeError(error, "保存本地设置失败。"));
    renderDynamic(state, refs);
  });
}

async function resetAllSettings(state: AppState, refs: Refs): Promise<void> {
  await resetStoredSettings();
  state.settings = { ...defaultSettings };
  syncFormValues(refs, state.settings);
  pushLog(state, "info", "已重置所有本地设置。");
  renderDynamic(state, refs);
}

async function wipeLocalData(state: AppState, refs: Refs): Promise<void> {
  await clearLocalData();
  state.settings = { ...defaultSettings };
  syncFormValues(refs, state.settings);
  pushLog(
    state,
    "info",
    `已清理本地数据。设置文件位置：${state.settingsFilePath || "未能读取"}`,
  );
  renderDynamic(state, refs);
}

function collectRefs(root: HTMLDivElement): Refs {
  const titlebarMinimizeButton = root.querySelector<HTMLButtonElement>("#titlebar-minimize-button");
  const titlebarMaximizeButton = root.querySelector<HTMLButtonElement>("#titlebar-maximize-button");
  const titlebarCloseButton = root.querySelector<HTMLButtonElement>("#titlebar-close-button");
  const form = root.querySelector<HTMLFormElement>("#settings-form");
  const runNote = root.querySelector<HTMLDivElement>("#run-note");
  const filesHint = root.querySelector<HTMLDivElement>("#files-hint");
  const outputPath = root.querySelector<HTMLDivElement>("#output-path");
  const statusBadge = root.querySelector<HTMLDivElement>("#status-badge");
  const stats = root.querySelector<HTMLDivElement>("#stats");
  const fileList = root.querySelector<HTMLDivElement>("#file-list");
  const logList = root.querySelector<HTMLDivElement>("#log-list");
  const localDataPath = root.querySelector<HTMLDivElement>("#local-data-path");
  const settingsPath = root.querySelector<HTMLDivElement>("#settings-path");
  const selectFilesButton = root.querySelector<HTMLButtonElement>("#select-files-button");
  const clearFilesButton = root.querySelector<HTMLButtonElement>("#clear-files-button");
  const chooseOutputButton = root.querySelector<HTMLButtonElement>("#choose-output-button");
  const openLocalDataButton = root.querySelector<HTMLButtonElement>("#open-local-data-button");
  const resetSettingsButton = root.querySelector<HTMLButtonElement>("#reset-settings-button");
  const clearLocalDataButton = root.querySelector<HTMLButtonElement>("#clear-local-data-button");
  const startButton = root.querySelector<HTMLButtonElement>("#start-button");
  const stopButton = root.querySelector<HTMLButtonElement>("#stop-button");

  if (
    !titlebarMinimizeButton ||
    !titlebarMaximizeButton ||
    !titlebarCloseButton ||
    !form ||
    !runNote ||
    !filesHint ||
    !outputPath ||
    !statusBadge ||
    !stats ||
    !fileList ||
    !logList ||
    !localDataPath ||
    !settingsPath ||
    !selectFilesButton ||
    !clearFilesButton ||
    !chooseOutputButton ||
    !openLocalDataButton ||
    !resetSettingsButton ||
    !clearLocalDataButton ||
    !startButton ||
    !stopButton
  ) {
    throw new Error("UI 初始化失败。");
  }

  return {
    titlebarMinimizeButton,
    titlebarMaximizeButton,
    titlebarCloseButton,
    form,
    runNote,
    filesHint,
    outputPath,
    statusBadge,
    stats,
    fileList,
    logList,
    localDataPath,
    settingsPath,
    selectFilesButton,
    clearFilesButton,
    chooseOutputButton,
    openLocalDataButton,
    resetSettingsButton,
    clearLocalDataButton,
    startButton,
    stopButton,
  };
}

function bindEvents(state: AppState, refs: Refs): void {
  syncFormValues(refs, state.settings);

  refs.titlebarMinimizeButton.addEventListener("click", async () => {
    try {
      await minimizeWindow();
    } catch (error) {
      pushLog(state, "error", describeError(error, "最小化窗口失败。"));
      renderDynamic(state, refs);
    }
  });

  refs.titlebarMaximizeButton.addEventListener("click", async () => {
    try {
      await toggleMaximizeWindow();
    } catch (error) {
      pushLog(state, "error", describeError(error, "切换窗口大小失败。"));
      renderDynamic(state, refs);
    }
  });

  refs.titlebarCloseButton.addEventListener("click", async () => {
    try {
      await closeWindow();
    } catch (error) {
      pushLog(state, "error", describeError(error, "关闭窗口失败。"));
      renderDynamic(state, refs);
    }
  });

  refs.form.addEventListener("input", () => {
    state.settings = readSettingsFromForm(refs.form, state.settings);
    persistSettings(state, refs);
  });

  refs.selectFilesButton.addEventListener("click", async () => {
    try {
      await chooseSubtitleFiles(state, refs);
    } catch (error) {
      const message = describeError(error, "读取文件失败。");
      pushLog(state, "error", message);
      renderDynamic(state, refs);
    }
  });

  refs.chooseOutputButton.addEventListener("click", async () => {
    try {
      await chooseOutputDirectory(state, refs);
    } catch (error) {
      const message = describeError(error, "选择目录失败。");
      pushLog(state, "error", message);
      renderDynamic(state, refs);
    }
  });

  refs.clearFilesButton.addEventListener("click", () => {
    clearFiles(state, refs);
  });

  refs.stopButton.addEventListener("click", () => {
    requestSoftStop(state, refs);
  });

  refs.openLocalDataButton.addEventListener("click", async () => {
    try {
      await openDirectoryInFileManager(state.localDataDirectory);
      pushLog(state, "info", `已打开数据目录：${state.localDataDirectory}`);
      renderDynamic(state, refs);
    } catch (error) {
      pushLog(state, "error", describeError(error, "打开数据目录失败。"));
      renderDynamic(state, refs);
    }
  });

  refs.resetSettingsButton.addEventListener("click", async () => {
    if (!window.confirm("这会清空已保存的接口、模型、Prompt 和参数，并恢复默认配置。确定继续吗？")) {
      return;
    }

    try {
      await resetAllSettings(state, refs);
    } catch (error) {
      pushLog(state, "error", describeError(error, "重置本地设置失败。"));
      renderDynamic(state, refs);
    }
  });

  refs.clearLocalDataButton.addEventListener("click", async () => {
    if (
      !window.confirm(
        "这会删除应用保存的本地设置文件，并清理旧版遗留的隐藏设置。程序文件和导出的字幕不会被删除。确定继续吗？",
      )
    ) {
      return;
    }

    try {
      await wipeLocalData(state, refs);
    } catch (error) {
      pushLog(state, "error", describeError(error, "清理本地数据失败。"));
      renderDynamic(state, refs);
    }
  });

  refs.startButton.addEventListener("click", async () => {
    if (isBusy(state)) {
      return;
    }

    try {
      await startBatchRun(state, refs);
    } catch {
      state.activeRun = null;
      state.runPhase = "idle";
      renderDynamic(state, refs);
    }
  });
}

export function mountApp(root: HTMLDivElement): void {
  renderShell(root);

  const state = createInitialState();
  const refs = collectRefs(root);

  bindEvents(state, refs);
  renderDynamic(state, refs);
  void hydratePersistence(state, refs);
}
