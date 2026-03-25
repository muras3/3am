export type Logger = "pino" | "winston" | "bunyan";

const LOGGER_INSTRUMENTATION: Record<Logger, string> = {
  pino: "@opentelemetry/instrumentation-pino",
  winston: "@opentelemetry/instrumentation-winston",
  bunyan: "@opentelemetry/instrumentation-bunyan",
};

export type LoggerDetection =
  | { detected: true; name: Logger; instrumentationPackage: string }
  | { detected: false; name: null; instrumentationPackage: null };

export function detectLogger(deps: Record<string, string>): LoggerDetection {
  for (const logger of Object.keys(LOGGER_INSTRUMENTATION) as Logger[]) {
    if (logger in deps) {
      return { detected: true, name: logger, instrumentationPackage: LOGGER_INSTRUMENTATION[logger] };
    }
  }
  return { detected: false, name: null, instrumentationPackage: null };
}
