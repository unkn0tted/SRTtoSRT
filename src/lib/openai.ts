import { invoke } from "@tauri-apps/api/core";
import { describeError, toError, truncateText } from "./errors";
import type {
  AppSettings,
  EnglishMode,
  SubtitleCue,
  TranslationSegment,
} from "./types";

interface ChatCompletionPayload {
  endpoint: string;
  apiKey?: string;
  payload: Record<string, unknown>;
  extraHeaders?: Record<string, string>;
  timeoutSecs: number;
}

interface ModelResponseItem {
  index: number;
  zh?: string;
  en?: string;
}

interface ParsedModelResponse {
  items: ModelResponseItem[];
}

function normalizeEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");

  if (!trimmed) {
    throw new Error("请填写 API Base URL。");
  }

  return trimmed.endsWith("/chat/completions")
    ? trimmed
    : `${trimmed}/chat/completions`;
}

function extractContent(response: Record<string, unknown>): string {
  const choices = response.choices;

  if (!Array.isArray(choices) || choices.length === 0) {
    throw new Error("模型响应中没有 choices。");
  }

  const first = choices[0];

  if (!first || typeof first !== "object") {
    throw new Error("模型响应格式异常。");
  }

  const message = (first as Record<string, unknown>).message;

  if (!message || typeof message !== "object") {
    throw new Error("模型响应中缺少 message。");
  }

  const content = (message as Record<string, unknown>).content;

  if (typeof content === "string") {
    return content;
  }

  if (Array.isArray(content)) {
    const text = content
      .map((part) => {
        if (!part || typeof part !== "object") {
          return "";
        }

        const record = part as Record<string, unknown>;

        if (record.type === "text" && typeof record.text === "string") {
          return record.text;
        }

        return "";
      })
      .join("");

    if (text) {
      return text;
    }
  }

  throw new Error("无法从模型响应中提取文本内容。");
}

function extractJsonPayload(raw: string): ParsedModelResponse {
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced?.[1]?.trim() || raw.trim();
  const firstBrace = candidate.indexOf("{");
  const lastBrace = candidate.lastIndexOf("}");

  if (firstBrace === -1 || lastBrace === -1 || firstBrace >= lastBrace) {
    throw new Error(`模型没有返回合法 JSON：${truncateText(candidate || raw, 240)}`);
  }

  const jsonSlice = candidate.slice(firstBrace, lastBrace + 1);
  let parsed: ParsedModelResponse;

  try {
    parsed = JSON.parse(jsonSlice) as ParsedModelResponse;
  } catch (error) {
    throw new Error(
      `模型返回 JSON 解析失败：${describeError(error)}；原文片段：${truncateText(jsonSlice, 240)}`,
    );
  }

  if (!parsed || !Array.isArray(parsed.items)) {
    throw new Error(`模型返回 JSON 里缺少 items 数组：${truncateText(jsonSlice, 240)}`);
  }

  return parsed;
}

function buildSystemPrompt(basePrompt: string, mode: EnglishMode): string {
  const outputRule =
    mode === "translate-to-english"
      ? [
          "Output JSON schema: {\"items\":[{\"index\":1,\"zh\":\"...\",\"en\":\"...\"}]}",
          "Each item must include both zh and en fields.",
          "The en field must be natural English subtitle text.",
        ]
      : [
          "Output JSON schema: {\"items\":[{\"index\":1,\"zh\":\"...\"}]}",
          "Each item must include zh only. Do not include any other fields.",
        ];

  return [basePrompt.trim(), ...outputRule].join("\n");
}

function buildUserPayload(items: SubtitleCue[], mode: EnglishMode): string {
  return JSON.stringify(
    {
      task: "Translate subtitle items for bilingual SRT export.",
      englishMode: mode,
      notes:
        mode === "translate-to-english"
          ? "Return Simplified Chinese and English."
          : "Return Simplified Chinese only. The original subtitle text will be reused as the second line.",
      items: items.map((cue) => ({
        index: cue.index,
        text: cue.text,
      })),
    },
    null,
    2,
  );
}

async function postChatCompletion(payload: ChatCompletionPayload): Promise<Record<string, unknown>> {
  try {
    return await invoke<Record<string, unknown>>("post_chat_completion", {
      request: payload,
    });
  } catch (error) {
    throw toError(error, "请求模型接口失败。");
  }
}

export async function translateCueBatch(
  cues: SubtitleCue[],
  settings: AppSettings,
  extraHeaders: Record<string, string>,
): Promise<TranslationSegment[]> {
  const response = await postChatCompletion({
    endpoint: normalizeEndpoint(settings.apiBaseUrl),
    apiKey: settings.apiKey.trim() || undefined,
    timeoutSecs: settings.timeoutSecs,
    extraHeaders,
    payload: {
      model: settings.model.trim(),
      temperature: 0.2,
      messages: [
        {
          role: "system",
          content: buildSystemPrompt(settings.systemPrompt, settings.englishMode),
        },
        {
          role: "user",
          content: buildUserPayload(cues, settings.englishMode),
        },
      ],
    },
  });

  const content = extractContent(response);
  const parsed = extractJsonPayload(content);
  const byIndex = new Map<number, ModelResponseItem>();

  for (const item of parsed.items) {
    if (!Number.isInteger(item.index)) {
      throw new Error("模型返回了无效 index。");
    }

    byIndex.set(item.index, item);
  }

  return cues.map((cue) => {
    const modelItem = byIndex.get(cue.index);

    if (!modelItem || typeof modelItem.zh !== "string" || !modelItem.zh.trim()) {
      throw new Error(`第 ${cue.index} 条字幕缺少中文翻译。`);
    }

    const en =
      settings.englishMode === "translate-to-english"
        ? modelItem.en?.trim()
        : cue.text;

    if (!en) {
      throw new Error(`第 ${cue.index} 条字幕缺少英文行。`);
    }

    return {
      index: cue.index,
      source: cue.text,
      zh: modelItem.zh.trim(),
      en,
    };
  });
}
