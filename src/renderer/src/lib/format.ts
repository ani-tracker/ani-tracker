export function formatBytes(bytes?: number): string {
  if (!bytes) {
    return "0 B";
  }

  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let index = 0;

  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }

  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}

export function formatSpeed(bytesPerSecond?: number): string {
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatPercent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

export function formatDuration(seconds?: number): string {
  if (!seconds || seconds < 0) {
    return "--";
  }

  const minutes = Math.floor(seconds / 60);
  const restSeconds = seconds % 60;

  if (minutes >= 60) {
    const hours = Math.floor(minutes / 60);
    return `${hours}h ${minutes % 60}m`;
  }

  return `${minutes}m ${restSeconds}s`;
}

export function formatMonth(year: number, month: number): string {
  return `${year} 年 ${month} 月`;
}

/** 格式化日期时间，无法解析时保留原始值方便排查来源数据。 */
export function formatDateTime(value?: string): string {
  if (!value) {
    return "--";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString();
}
