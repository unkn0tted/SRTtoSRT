import { open } from "@tauri-apps/plugin-dialog";
import { readTextFile, remove, writeTextFile } from "@tauri-apps/plugin-fs";
import { loadTranslationCheckpoint, saveTranslationCheckpoint } from "./lib/checkpoint";
import { describeError } from "./lib/errors";
import { translateCueBatch } from "./lib/openai";
import { buildBatches, buildSrtContent, parseSrt } from "./lib/srt";
import {
  clearLocalData,
  defaultSettings,
  getLocalDataDirectory,
  getSettingsFilePath,
  loadSettings,
  openDirectoryInFileManager,
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

interface AppState {
  settings: AppSettings;
  files: ParsedSubtitleFile[];
  tasks: FileTask[];
  outputDirectory: string;
  localDataDirectory: string;
  settingsFilePath: string;
  logs: LogEntry[];
  running: boolean;
}

interface Refs {
  form: HTMLFormElement;
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
}

const rootId = "subtitle-duet-shell";

function uid(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function createInitialState(): AppState {
  return {
    settings: { ...defaultSettings },
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
    running: false,
  };
}

function renderShell(root: HTMLDivElement): void {
  root.innerHTML = `
    <div class="shell" id="${rootId}">
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
                当前版本会把本地设置保存到上面的 `settings.json`。点击“清理本地数据”会删除这个文件，并清理旧版遗留的隐藏设置。
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

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
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

async function translateCueBatchWithRecovery(
  batch: SubtitleCue[],
  settings: AppSettings,
  extraHeaders: Record<string, string>,
  note: (message: string) => void,
): Promise<TranslationSegment[]> {
  const maxAttempts = batch.length === 1 ? 3 : 2;
  const retryDelays = [1200, 2400];
  let lastError: unknown;
  let lastMessage = "未知错误";

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await translateCueBatch(batch, settings, extraHeaders);
    } catch (error) {
      lastError = error;
      lastMessage = describeError(error);

      if (attempt < maxAttempts && isRetryableBatchError(lastMessage)) {
        note(
          `${formatCueRange(batch)} 第 ${attempt + 1}/${maxAttempts} 次尝试前重试：${lastMessage}`,
        );
        await wait(retryDelays[Math.min(attempt - 1, retryDelays.length - 1)]);
        continue;
      }

      break;
    }
  }

  if (batch.length > 1 && !isPermanentBatchError(lastMessage)) {
    const mid = Math.ceil(batch.length / 2);
    const left = batch.slice(0, mid);
    const right = batch.slice(mid);

    note(
      `${formatCueRange(batch)} 仍然失败，自动拆分为 ${left.length}+${right.length} 条继续重试。`,
    );

    const leftResult = await translateCueBatchWithRecovery(left, settings, extraHeaders, note);
    const rightResult = await translateCueBatchWithRecovery(right, settings, extraHeaders, note);

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
  const totalCount = state.tasks.length;
  const doneLines = state.tasks.reduce((sum, task) => sum + task.completed, 0);
  const totalLines = state.tasks.reduce((sum, task) => sum + task.total, 0);

  refs.stats.textContent =
    totalCount === 0
      ? "尚未添加文件"
      : `${totalCount} 个文件 / ${doneLines}/${totalLines} 条字幕 / 成功 ${successCount} / 失败 ${errorCount}`;

  refs.outputPath.textContent = state.outputDirectory || "未选择，开始前必须指定";
  refs.localDataPath.textContent = state.localDataDirectory || "读取中...";
  refs.settingsPath.textContent = state.settingsFilePath || "读取中...";
  refs.filesHint.textContent =
    state.files.length === 0
      ? "建议先选择 2-3 个样本文件测试 prompt 和接口稳定性，再跑整批任务。"
      : `已载入 ${state.files.length} 个文件。当前仅支持 SRT，输出文件名会追加 .bilingual.srt。`;

  refs.statusBadge.textContent = state.running ? "运行中" : "就绪";
  refs.statusBadge.dataset.status = state.running ? "running" : "idle";

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
                    <span class="pill">${task.status}</span>
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

  refs.selectFilesButton.disabled = state.running;
  refs.clearFilesButton.disabled = state.running || state.files.length === 0;
  refs.chooseOutputButton.disabled = state.running;
  refs.openLocalDataButton.disabled = !state.localDataDirectory;
  refs.resetSettingsButton.disabled = state.running;
  refs.clearLocalDataButton.disabled = state.running;
  refs.startButton.disabled = state.running || state.files.length === 0;

  Array.from(refs.form.elements).forEach((element) => {
    if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement)) {
      return;
    }

    element.disabled = state.running;
  });
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

function validateBeforeRun(state: AppState): Record<string, string> {
  if (!state.settings.apiBaseUrl.trim()) {
    throw new Error("API Base URL 不能为空。");
  }

  if (!state.settings.model.trim()) {
    throw new Error("Model 不能为空。");
  }

  if (!state.outputDirectory.trim()) {
    throw new Error("请先选择输出目录。");
  }

  return parseExtraHeaders(state.settings.extraHeaders);
}

async function translateFile(
  file: ParsedSubtitleFile,
  state: AppState,
  refs: Refs,
  extraHeaders: Record<string, string>,
): Promise<void> {
  const outputFileName = `${removeExtension(file.name)}.bilingual.srt`;
  const outputPath = joinPath(state.outputDirectory, outputFileName);
  const checkpointPath = joinPath(
    state.outputDirectory,
    `${removeExtension(file.name)}.bilingual.checkpoint.json`,
  );
  const batches = buildBatches(
    file.cues,
    state.settings.batchSize,
    state.settings.batchCharLimit,
  );
  const checkpoint = await loadTranslationCheckpoint(
    checkpointPath,
    file,
    state.settings,
    extraHeaders,
  );
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
        state.settings,
        extraHeaders,
        snapshot,
      ),
    );

    await checkpointWrite;
  };

  await mapLimit(
    pendingBatches,
    state.settings.concurrency,
    async ({ originalIndex, cues }) => {
      try {
        const result = await translateCueBatchWithRecovery(
          cues,
          state.settings,
          extraHeaders,
          (message) => {
            pushLog(
              state,
              "info",
              `${file.name} 批次 ${originalIndex + 1}/${batches.length}：${message}`,
            );
            renderDynamic(state, refs);
          },
        );

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
        throw new Error(
          `批次 ${originalIndex + 1}/${batches.length}（${formatCueRange(cues)}）失败：${describeError(error)}`,
        );
      }
    },
  );

  await checkpointWrite;

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
  let extraHeaders: Record<string, string>;

  try {
    extraHeaders = validateBeforeRun(state);
  } catch (error) {
    const message = describeError(error, "配置校验失败。");
    pushLog(state, "error", message);
    renderDynamic(state, refs);
    throw error;
  }

  state.running = true;
  state.tasks = state.tasks.map((task) => ({
    ...task,
    status: "queued",
    completed: 0,
    message: "排队中",
    outputPath: undefined,
  }));
  pushLog(state, "info", `开始批量翻译，共 ${state.files.length} 个文件。`);
  renderDynamic(state, refs);

  for (const file of state.files) {
    try {
      await translateFile(file, state, refs, extraHeaders);
    } catch (error) {
      const task = state.tasks.find((item) => item.fileId === file.id);
      const resumeHint =
        task && task.completed > 0
          ? ` 已保存 ${task.completed}/${task.total} 条断点，重新点击“开始翻译”可继续。`
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

  state.running = false;
  pushLog(state, "info", "本轮任务结束。");
  renderDynamic(state, refs);
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
  const form = root.querySelector<HTMLFormElement>("#settings-form");
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

  if (
    !form ||
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
    !startButton
  ) {
    throw new Error("UI 初始化失败。");
  }

  return {
    form,
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
  };
}

function bindEvents(state: AppState, refs: Refs): void {
  syncFormValues(refs, state.settings);

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
    if (state.running) {
      return;
    }

    try {
      await startBatchRun(state, refs);
    } catch {
      state.running = false;
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
