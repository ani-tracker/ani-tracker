type LogLevel = "info" | "warn" | "error";

export const logger = {
  info: (message: string, context?: Record<string, unknown>) => log("info", message, context),
  warn: (message: string, context?: Record<string, unknown>) => log("warn", message, context),
  error: (message: string, context?: Record<string, unknown>) => log("error", message, context)
};

function log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
  const payload = context ? ` ${JSON.stringify(context)}` : "";
  const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] ${message}${payload}`;

  if (level === "error") {
    console.error(line);
    return;
  }

  if (level === "warn") {
    console.warn(line);
    return;
  }

  console.log(line);
}
