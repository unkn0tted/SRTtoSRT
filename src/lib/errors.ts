function truncateText(text: string, maxChars = 400): string {
  const normalized = text.trim();

  if (!normalized) {
    return "";
  }

  if (normalized.length <= maxChars) {
    return normalized;
  }

  return `${normalized.slice(0, maxChars)}...`;
}

export function describeError(error: unknown, fallback = "未知错误"): string {
  if (error instanceof Error) {
    return truncateText(error.message || fallback) || fallback;
  }

  if (typeof error === "string") {
    return truncateText(error) || fallback;
  }

  if (
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    return String(error);
  }

  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;

    for (const key of ["message", "error", "reason", "details"]) {
      const value = record[key];

      if (typeof value === "string" && value.trim()) {
        return truncateText(value) || fallback;
      }
    }

    try {
      const serialized = JSON.stringify(error);

      if (serialized && serialized !== "{}") {
        return truncateText(serialized) || fallback;
      }
    } catch {
      // Ignore serialization errors and fall back below.
    }
  }

  return fallback;
}

export function toError(error: unknown, fallback = "未知错误"): Error {
  if (error instanceof Error && error.message.trim()) {
    return error;
  }

  return new Error(describeError(error, fallback));
}

export { truncateText };
