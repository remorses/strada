// Parse raw stack trace strings into structured frames during ingest.
// Ported from https://github.com/highlight/highlight/blob/main/backend/stacktraces/stacktraces.go

export interface ParsedStackFrame {
  filename?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  in_app?: boolean;
  line_content?: string;
}

export interface ParsedStackTrace {
  language: string;
  errorMessage: string;
  frames: ParsedStackFrame[];
}

type Language = "unknown" | "js-otel" | "js" | "python" | "golang" | "dotnet" | "ruby";

const jsPattern = /^ {4}at ((.+) )?\(?(.+):(\d+):(\d+)\)?$/;
const jsAnonPattern = /^ {4}at (.+) \((.+)\)$/;
const jsOtelPattern = /^(.*)@(.+\.js):(\d+):(\d+)$/;
const pyPattern = /^ {2}File "(.+)", line (\d+), in (\w+)$/;
const pyExcPattern = /^(\S.+)$/;
const pyUnderPattern = /^\s*[\^~]+\s*$/;
const pyMultiPattern = /^During handling of the above exception, another exception occurred:$/;
const rubyPattern = /^\tfrom (.+):(\d+)( 0x[0-f]+)?$/;
const goLinePattern = /^\t(.+):(\d+)( 0x[0-f]+)?$/;
const goFuncPattern = /^(.+)\.(.+?)(\([^()]*\))?$/;
const goRecoveredPanicPattern = /^\s*runtime\.gopanic\s*$/;
const dotnetCsPattern = /\.cs/;
const dotnetExceptionPattern = /^([\w.]+: .+?)( at .+)?$/;
const dotnetFilePattern = /^\s*at (.+?)(?: in (.+?)(?::line (\d+))?)?$/;
const generalPattern = /^(.+)$/;

interface WorkingFrame extends ParsedStackFrame {
  error: string;
}

export function parseStackTrace(stackTrace: string): ParsedStackTrace {
  let normalized = stackTrace;
  try {
    const parsed = JSON.parse(stackTrace);
    if (typeof parsed === "string") {
      normalized = parsed;
    }
  } catch {
    // keep raw string
  }

  let language: Language = dotnetCsPattern.test(normalized) ? "dotnet" : "unknown";
  let errorMessage = "";
  let frame: WorkingFrame | undefined;
  let frames: WorkingFrame[] | null = [];
  const lines = normalized.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";

    if (frames === null) {
      frames = [];
      continue;
    }

    if (line === "Traceback (most recent call last):") {
      language = "python";
      continue;
    }

    if (index === 0) {
      if (line === "") {
        language = "golang";
        continue;
      }

      const dotnetExceptionMatch = language === "dotnet" ? line.match(dotnetExceptionPattern) : null;
      if (dotnetExceptionMatch) {
        errorMessage = dotnetExceptionMatch[1] ?? "";
        const extraFrames = (dotnetExceptionMatch[2] ?? "").replaceAll(" at ", "\n at ").split("\n");
        if (extraFrames.length > 0) {
          lines.push(...extraFrames);
        }
        continue;
      }

      if (line.match(jsOtelPattern)) {
        language = "js-otel";
      }

      if (language !== "js-otel") {
        errorMessage = line;
        continue;
      }
    }

    if (line === "") {
      continue;
    }

    if (language === "python" && index === lines.length - 2) {
      errorMessage = line;
      continue;
    }

    if (language === "python" && pyUnderPattern.test(line)) {
      continue;
    }

    if (language === "python" && pyMultiPattern.test(line)) {
      continue;
    }

    if (!errorMessage) {
      errorMessage = line;
    }

    if (!frame) {
      frame = { error: errorMessage };
    }

    const dotnetFileMatch = language === "dotnet" ? line.match(dotnetFilePattern) : null;
    if (dotnetFileMatch) {
      frame.function = dotnetFileMatch[1] || undefined;
      frame.filename = dotnetFileMatch[2] || undefined;
      frame.lineno = parseOptionalInt(dotnetFileMatch[3]);
    } else {
      const jsMatch = line.match(jsPattern);
      if (jsMatch) {
        language = "js";
        frame.function = jsMatch[2] || undefined;
        frame.filename = jsMatch[3] || undefined;
        frame.lineno = parseOptionalInt(jsMatch[4]);
        frame.colno = parseOptionalInt(jsMatch[5]);
      } else {
        const jsAnonMatch = line.match(jsAnonPattern);
        if (jsAnonMatch) {
          language = "js";
          frame.function = jsAnonMatch[1] || undefined;
          frame.filename = jsAnonMatch[2] || undefined;
          frame.line_content = jsAnonMatch[2] || undefined;
        } else {
          const jsOtelMatch = line.match(jsOtelPattern);
          if (jsOtelMatch) {
            language = "js-otel";
            frame.function = jsOtelMatch[1] || undefined;
            frame.filename = jsOtelMatch[2] || undefined;
            frame.lineno = parseOptionalInt(jsOtelMatch[3]);
            frame.colno = parseOptionalInt(jsOtelMatch[4]);
          } else {
            const pyMatch = line.match(pyPattern);
            if (pyMatch) {
              language = "python";
              frame.function = pyMatch[3] || undefined;
              frame.filename = pyMatch[1] || undefined;
              frame.lineno = parseOptionalInt(pyMatch[2]);
              continue;
            }

            const rubyMatch = line.match(rubyPattern);
            if (rubyMatch) {
              language = "ruby";
              frame.filename = rubyMatch[1] || undefined;
              frame.lineno = parseOptionalInt(rubyMatch[2]);
            } else if (line.match(goRecoveredPanicPattern)) {
              language = "golang";
              frames = null;
              frame = undefined;
              errorMessage = "";
              continue;
            } else {
              const goLineMatch = line.match(goLinePattern);
              if (goLineMatch) {
                language = "golang";
                frame.filename = goLineMatch[1] || undefined;
                frame.lineno = parseOptionalInt(goLineMatch[2]);
              } else {
                const goFuncMatch = language === "golang" ? line.match(goFuncPattern) : null;
                if (goFuncMatch) {
                  frame.function = goFuncMatch[2] || undefined;
                  continue;
                }

                const generalMatch = line.match(generalPattern);
                if (generalMatch) {
                  if (language === "golang") {
                    frame.function = generalMatch[1] || undefined;
                    continue;
                  }

                  if (language === "python" && line.match(pyExcPattern)) {
                    errorMessage = line;
                    continue;
                  }

                  frame.line_content = generalMatch[1] || undefined;
                }
              }
            }
          }
        }
      }
    }

    frame.in_app = isInAppFrame(frame.filename);
    frames.push(frame);
    frame = undefined;
  }

  const finalFrames = frames ?? [];
  if (language !== "js-otel" && language !== "golang" && language !== "dotnet" && language !== "ruby") {
    finalFrames.reverse();
  }

  return {
    language,
    errorMessage,
    frames: finalFrames.map(({ error: _error, ...rest }) => rest),
  };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function isInAppFrame(filename: string | undefined): boolean {
  if (!filename) return false;

  return ![
    "node_modules/",
    "node:internal/",
    "/usr/local/go/src/",
    "/go/pkg/mod/",
    "/site-packages/",
    "/dist/",
    "webpack-internal:///",
    "[native code]",
  ].some((pattern) => filename.includes(pattern));
}
