import type { SubtitleCue, TranslationSegment } from "./types";

const TIMING_PATTERN =
  /^(\d{2}:\d{2}:\d{2},\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2},\d{3})(.*)$/;

function normalize(input: string): string {
  return input.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").trim();
}

export function parseSrt(content: string): SubtitleCue[] {
  const normalized = normalize(content);

  if (!normalized) {
    return [];
  }

  const blocks = normalized.split(/\n{2,}/);
  const cues: SubtitleCue[] = [];

  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trimEnd());

    if (lines.length < 2) {
      continue;
    }

    let lineOffset = 0;
    const maybeIndex = Number(lines[0]);

    if (Number.isInteger(maybeIndex)) {
      lineOffset = 1;
    }

    const timingLine = lines[lineOffset];
    const match = timingLine.match(TIMING_PATTERN);

    if (!match) {
      continue;
    }

    const [, start, end, trailing] = match;
    const textLines = lines.slice(lineOffset + 1);
    const text = textLines.join("\n").trim();

    if (!text) {
      continue;
    }

    cues.push({
      index: cues.length + 1,
      start,
      end,
      trailing,
      text,
    });
  }

  return cues;
}

export function buildSrtContent(
  cues: SubtitleCue[],
  translations: TranslationSegment[],
): string {
  if (cues.length !== translations.length) {
    throw new Error("字幕条目数和翻译结果不一致。");
  }

  return cues
    .map((cue, idx) => {
      const translation = translations[idx];
      const bilingualText = `${translation.zh}\n${translation.en}`;

      return [
        String(idx + 1),
        `${cue.start} --> ${cue.end}${cue.trailing}`,
        bilingualText,
      ].join("\n");
    })
    .join("\n\n");
}

export function buildBatches(
  cues: SubtitleCue[],
  batchSize: number,
  charLimit: number,
): SubtitleCue[][] {
  const safeBatchSize = Math.max(1, batchSize);
  const safeCharLimit = Math.max(500, charLimit);
  const batches: SubtitleCue[][] = [];
  let current: SubtitleCue[] = [];
  let currentChars = 0;

  for (const cue of cues) {
    const cueChars = cue.text.length + 32;
    const exceedsCount = current.length >= safeBatchSize;
    const exceedsChars = current.length > 0 && currentChars + cueChars > safeCharLimit;

    if (exceedsCount || exceedsChars) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }

    current.push(cue);
    currentChars += cueChars;
  }

  if (current.length > 0) {
    batches.push(current);
  }

  return batches;
}
