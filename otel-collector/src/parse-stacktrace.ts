// Parse raw stack trace strings into structured frames during ingest.
// Ported from https://github.com/highlight/highlight/blob/main/backend/stacktraces/stacktraces.go
//
// Refactored from the original nested if/else pyramid into flat early-continue
// blocks. Each regex match attempt is a standalone block that applies to the
// frame and continues. This keeps the happy path at root indentation level.
//
// The `fromOtel` option forces language to "js-otel" when JS patterns match,
// matching the Go original's StructureStackTraceOption. This matters because
// frame reversal at the end skips "js-otel" traces (OTel sends frames in the
// correct order already).

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

export interface ParseStackTraceOptions {
  /** When true, JS stack traces keep language as "js-otel" instead of "js".
   *  This prevents incorrect frame reversal for OTel-sourced JS traces. */
  fromOtel?: boolean;
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

export function parseStackTrace(stackTrace: string, options?: ParseStackTraceOptions): ParsedStackTrace {
  const fromOtel = options?.fromOtel ?? false;
  const normalized = normalizeInput(stackTrace);

  let language: Language = dotnetCsPattern.test(normalized) ? "dotnet" : "unknown";
  let errorMessage = "";
  let frames: ParsedStackFrame[] = [];
  let frame: ParsedStackFrame | undefined;
  // When true, the next iteration resets frames (used after runtime.gopanic)
  let resetOnNextLine = false;

  const lines = normalized.split("\n");

  for (let index = 0; index < lines.length; index++) {
    const line = lines[index] ?? "";

    if (resetOnNextLine) {
      resetOnNextLine = false;
      frames = [];
      continue;
    }

    // Python traceback header
    if (line === "Traceback (most recent call last):") {
      language = "python";
      continue;
    }

    // First line: extract error message and detect language
    if (index === 0) {
      const result = parseFirstLine(line, language);
      language = result.language;
      errorMessage = result.errorMessage;
      if (result.extraLines) lines.push(...result.extraLines);
      if (result.skipLine) continue;
      // For js-otel, first line IS a frame, so fall through
    }

    if (line === "") continue;

    // Python: second-to-last line is the error message
    if (language === "python" && index === lines.length - 2) {
      errorMessage = line;
      continue;
    }

    // Python: skip underline markers (^^^) and multi-exception separators
    if (language === "python" && pyUnderPattern.test(line)) continue;
    if (language === "python" && pyMultiPattern.test(line)) continue;

    if (!errorMessage) errorMessage = line;
    if (!frame) frame = {};

    // ── Pattern matching: flat early-continue blocks ──
    // Each block tries one regex. On match, it fills the frame and either
    // continues (for two-line patterns like Python/Go) or falls through
    // to push the frame.

    // .NET: at Function() in File.cs:line N
    if (language === "dotnet") {
      const m = line.match(dotnetFilePattern);
      if (m) {
        frame.function = m[1] || undefined;
        frame.filename = m[2] || undefined;
        frame.lineno = parseOptionalInt(m[3]);
        frame.in_app = isInAppFrame(frame.filename, language);
        frames.push(frame);
        frame = undefined;
        continue;
      }
    }

    // JS: "    at Function (file:line:col)"
    const jsMatch = line.match(jsPattern);
    if (jsMatch) {
      language = fromOtel ? "js-otel" : "js";
      frame.function = jsMatch[2] || undefined;
      frame.filename = jsMatch[3] || undefined;
      frame.lineno = parseOptionalInt(jsMatch[4]);
      frame.colno = parseOptionalInt(jsMatch[5]);
      frame.in_app = isInAppFrame(frame.filename, language);
      frames.push(frame);
      frame = undefined;
      continue;
    }

    // JS anonymous: "    at eval (code string)"
    const jsAnonMatch = line.match(jsAnonPattern);
    if (jsAnonMatch) {
      language = fromOtel ? "js-otel" : "js";
      frame.function = jsAnonMatch[1] || undefined;
      frame.filename = jsAnonMatch[2] || undefined;
      frame.line_content = jsAnonMatch[2] || undefined;
      frame.in_app = isInAppFrame(frame.filename, language);
      frames.push(frame);
      frame = undefined;
      continue;
    }

    // JS OTel: "func@file.js:line:col"
    const jsOtelMatch = line.match(jsOtelPattern);
    if (jsOtelMatch) {
      language = "js-otel";
      frame.function = jsOtelMatch[1] || undefined;
      frame.filename = jsOtelMatch[2] || undefined;
      frame.lineno = parseOptionalInt(jsOtelMatch[3]);
      frame.colno = parseOptionalInt(jsOtelMatch[4]);
      frame.in_app = isInAppFrame(frame.filename, language);
      frames.push(frame);
      frame = undefined;
      continue;
    }

    // Python: '  File "path", line N, in func'
    // Two-line pattern: this line is the frame header, next line is source code
    const pyMatch = line.match(pyPattern);
    if (pyMatch) {
      language = "python";
      frame.function = pyMatch[3] || undefined;
      frame.filename = pyMatch[1] || undefined;
      frame.lineno = parseOptionalInt(pyMatch[2]);
      // Don't push yet; the next line may be source code (line_content)
      continue;
    }

    // Ruby: "\tfrom file:line"
    const rubyMatch = line.match(rubyPattern);
    if (rubyMatch) {
      language = "ruby";
      frame.filename = rubyMatch[1] || undefined;
      frame.lineno = parseOptionalInt(rubyMatch[2]);
      frame.in_app = isInAppFrame(frame.filename, language);
      frames.push(frame);
      frame = undefined;
      continue;
    }

    // Go: runtime.gopanic resets the stack (recovered panic)
    if (line.match(goRecoveredPanicPattern)) {
      language = "golang";
      resetOnNextLine = true;
      frame = undefined;
      errorMessage = "";
      continue;
    }

    // Go: "\tfile:line +0xaddr"
    const goLineMatch = line.match(goLinePattern);
    if (goLineMatch) {
      language = "golang";
      frame.filename = goLineMatch[1] || undefined;
      frame.lineno = parseOptionalInt(goLineMatch[2]);
      frame.in_app = isInAppFrame(frame.filename, language);
      frames.push(frame);
      frame = undefined;
      continue;
    }

    // Go: function line (package.Func or package.(*Type).Method)
    if (language === "golang") {
      const goFuncMatch = line.match(goFuncPattern);
      if (goFuncMatch) {
        frame.function = goFuncMatch[2] || undefined;
        continue;
      }
    }

    // General fallback
    const generalMatch = line.match(generalPattern);
    if (generalMatch) {
      if (language === "golang") {
        frame.function = generalMatch[1] || undefined;
        continue;
      }
      if (language === "python" && pyExcPattern.test(line)) {
        errorMessage = line;
        continue;
      }
      frame.line_content = generalMatch[1] || undefined;
    }

    frame.in_app = isInAppFrame(frame.filename, language);
    frames.push(frame);
    frame = undefined;
  }

  // For some non-OTel-native errors, stacktraces are sent top-down
  // (top frame is outermost, bottom is innermost). Reverse so innermost is first.
  if (language !== "js-otel" && language !== "golang" && language !== "dotnet" && language !== "ruby") {
    frames.reverse();
  }

  return { language, errorMessage, frames };
}

// ─── Helpers ───

/** Try to unwrap a JSON-encoded string (OTel sometimes double-encodes). */
function normalizeInput(stackTrace: string): string {
  try {
    const parsed = JSON.parse(stackTrace);
    if (typeof parsed === "string") return parsed;
  } catch {
    // not JSON, use raw
  }
  return stackTrace;
}

/** Parse the first line of a stack trace to detect language and extract error message. */
function parseFirstLine(
  line: string,
  currentLanguage: Language,
): { language: Language; errorMessage: string; extraLines?: string[]; skipLine: boolean } {
  if (line === "") {
    return { language: "golang", errorMessage: "", skipLine: true };
  }

  if (currentLanguage === "dotnet") {
    const m = line.match(dotnetExceptionPattern);
    if (m) {
      const extra = (m[2] ?? "").replaceAll(" at ", "\n at ").split("\n");
      return {
        language: "dotnet",
        errorMessage: m[1] ?? "",
        extraLines: extra.length > 0 ? extra : undefined,
        skipLine: true,
      };
    }
  }

  if (line.match(jsOtelPattern)) {
    return { language: "js-otel", errorMessage: "", skipLine: false };
  }

  return { language: currentLanguage, errorMessage: line, skipLine: true };
}

function parseOptionalInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/** Determine if a frame is from application code vs third-party/runtime.
 *  Language-aware: some patterns only apply to specific languages. */
export function isInAppFrame(filename: string | undefined, language: Language = "unknown"): boolean {
  if (!filename) return false;

  // Universal exclusions (apply to all languages)
  const universalExclusions = [
    "node_modules/",
    "node:internal/",
    "/site-packages/",
    "/dist-packages/",
    "webpack-internal:///",
    "[native code]",
    "<anonymous>",
    "<eval>",
    "wasm://",
    ".cache/",
  ];

  for (const pattern of universalExclusions) {
    if (filename.includes(pattern)) return false;
  }

  // Node.js built-in modules: node:fs, node:http, etc.
  if (filename.startsWith("node:")) return false;

  // Language-specific exclusions
  if (language === "js" || language === "js-otel") {
    // Already covered by universal patterns above
  }

  if (language === "python") {
    if (filename.includes("/lib/python")) return false;
    if (filename.includes(".venv/")) return false;
    if (filename.includes("/virtualenvs/")) return false;
  }

  if (language === "golang") {
    if (filename.includes("/usr/local/go/src/")) return false;
    if (filename.includes("/go/pkg/mod/")) return false;
    // Go runtime paths like runtime/panic.go, runtime/proc.go
    if (filename.startsWith("runtime/")) return false;
  }

  if (language === "ruby") {
    if (filename.includes("/gems/")) return false;
    if (filename.startsWith("<internal:")) return false;
  }

  // .NET: function names contain System.* or Microsoft.* namespaces
  // but these show up in the function field, not filename.
  // Filename exclusions for .NET framework source paths:
  if (language === "dotnet") {
    if (filename.includes("/_/src/")) return false;
  }

  return true;
}
