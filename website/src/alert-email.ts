// Email template generation for error alerts.
// Uses markdown rendered to HTML via marked, wrapped in a minimal HTML shell.
// Untrusted fields (exception message, type, stacktrace) are escaped BEFORE
// interpolation into the markdown template so marked never sees raw HTML
// from attacker-controlled input.
// No background or text color set so emails inherit the user's system
// light/dark mode preference. Sans-serif font, Vercel-like minimal design.

import { marked } from 'marked'
import dedent from 'string-dedent'

export interface ErrorAlertData {
  projectSlug: string
  orgName: string
  fingerprintHash: string
  exceptionType: string
  exceptionMessage: string
  exceptionStacktrace: string
  errorCount: number
  windowMinutes: number
  firstSeen: string
  serviceName?: string
}

/** Escape HTML entities in untrusted strings before interpolating into markdown. */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s
  return s.slice(0, max - 1) + '\u2026'
}

/** Trim stacktrace to a reasonable size for email. */
function trimStacktrace(s: string, maxLines: number = 20): string {
  if (!s) return ''
  const lines = s.split('\n')
  if (lines.length <= maxLines) return s
  return lines.slice(0, maxLines).join('\n') + `\n... ${lines.length - maxLines} more lines`
}

/** Render markdown string to a complete HTML email document. */
function renderEmail(md: string): string {
  const bodyHtml = marked.parse(md, { async: false }) as string
  return dedent`
    <!DOCTYPE html>
    <html>
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <meta name="color-scheme" content="light dark">
      <meta name="supported-color-schemes" content="light dark">
      <style>
        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
          line-height: 1.5;
          max-width: 600px;
          margin: 0 auto;
          padding: 32px 24px;
          -webkit-text-size-adjust: 100%;
        }
        code {
          font-family: 'SF Mono', SFMono-Regular, Menlo, Consolas, monospace;
          font-size: 0.875em;
          padding: 2px 6px;
          border-radius: 4px;
          background: rgba(127, 127, 127, 0.12);
        }
        pre {
          padding: 16px;
          border-radius: 8px;
          overflow-x: auto;
          font-size: 0.8125em;
          line-height: 1.4;
          background: rgba(127, 127, 127, 0.08);
        }
        pre code {
          padding: 0;
          background: none;
        }
        hr {
          border: none;
          border-top: 1px solid rgba(127, 127, 127, 0.2);
          margin: 24px 0;
        }
        a { color: inherit; }
        h1, h2, h3 { font-weight: 600; }
        p { margin: 12px 0; }
        .footer { font-size: 0.75em; opacity: 0.5; margin-top: 32px; }
      </style>
    </head>
    <body>
      ${bodyHtml}
    </body>
    </html>
  `
}

/** Build the subject line for an error alert email. */
export function buildAlertSubject(data: ErrorAlertData): string {
  const type = data.exceptionType || 'Error'
  const msg = truncate(data.exceptionMessage || '(no message)', 60)
  return `[${data.orgName} / ${data.projectSlug}] ${type}: ${msg}`
}

/** Build the full HTML email body for an error alert. */
export function buildAlertEmailHtml(data: ErrorAlertData): string {
  // Escape all untrusted fields before interpolating into markdown
  const type = escapeHtml(data.exceptionType || 'Error')
  const message = escapeHtml(data.exceptionMessage || '(no message)')
  const service = data.serviceName ? escapeHtml(data.serviceName) : ''
  const project = escapeHtml(data.projectSlug)
  const org = escapeHtml(data.orgName)
  const fingerprint = escapeHtml(data.fingerprintHash)
  const firstSeen = escapeHtml(data.firstSeen)
  const stacktrace = escapeHtml(trimStacktrace(data.exceptionStacktrace))

  const serviceLine = service ? `\n**Service:** ${service}` : ''
  const stacktraceSection = stacktrace
    ? `\n---\n\n**Stacktrace**\n\n\`\`\`\n${stacktrace}\n\`\`\``
    : ''

  const md = dedent`
    ## ${type}

    ${message}

    ---

    **${data.errorCount}** errors in the last **${data.windowMinutes} minutes**

    **Org:** ${org}
    **Project:** ${project}${serviceLine}
    **Fingerprint:** \`${fingerprint}\`
    **First seen:** ${firstSeen}
    ${stacktraceSection}

    ---

    View this issue:

    \`\`\`
    strada issues view ${fingerprint} -p ${project}
    \`\`\`

    <p class="footer">Strada &middot; ${org}</p>
  `

  return renderEmail(md)
}

/** Build a test alert email. */
export function buildTestAlertEmailHtml(orgName: string): string {
  const org = escapeHtml(orgName)

  const md = dedent`
    ## Test alert

    This is a test alert from Strada to verify your notification setup works.

    If you received this, your alert configuration is working correctly.

    ---

    <p class="footer">Strada &middot; ${org}</p>
  `

  return renderEmail(md)
}
