// Email template generation for error alerts.
// Builds HTML directly with escaped untrusted fields (exception message,
// type, stacktrace) instead of markdown to prevent HTML injection.
// No background or text color set so emails inherit the user's system
// light/dark mode preference. Sans-serif font, Vercel-like minimal design.

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

/** HTML shell wrapping email body content. */
function wrapHtml(bodyHtml: string): string {
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
        h2 { font-weight: 600; margin-top: 0; }
        p { margin: 12px 0; }
        .meta { opacity: 0.7; font-size: 0.875em; }
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
  const type = escapeHtml(data.exceptionType || 'Error')
  const message = escapeHtml(data.exceptionMessage || '(no message)')
  const service = data.serviceName ? escapeHtml(data.serviceName) : ''
  const project = escapeHtml(data.projectSlug)
  const org = escapeHtml(data.orgName)
  const fingerprint = escapeHtml(data.fingerprintHash)
  const firstSeen = escapeHtml(data.firstSeen)
  const stacktrace = trimStacktrace(data.exceptionStacktrace)

  let body = dedent`
    <h2>${type}</h2>
    <p>${message}</p>
    <hr>
    <p>
      <strong>${data.errorCount}</strong> errors in the last <strong>${data.windowMinutes} minutes</strong>
    </p>
    <p class="meta">
      <strong>Org:</strong> ${org}<br>
      <strong>Project:</strong> ${project}${service ? `<br><strong>Service:</strong> ${service}` : ''}<br>
      <strong>Fingerprint:</strong> <code>${fingerprint}</code><br>
      <strong>First seen:</strong> ${firstSeen}
    </p>
  `

  if (stacktrace) {
    body += dedent`

      <hr>
      <p><strong>Stacktrace</strong></p>
      <pre><code>${escapeHtml(stacktrace)}</code></pre>
    `
  }

  body += dedent`

    <hr>
    <p>View this issue:</p>
    <pre><code>strada issues view ${fingerprint} -p ${project}</code></pre>
    <p class="footer">Strada &middot; ${org}</p>
  `

  return wrapHtml(body)
}

/** Build a test alert email. */
export function buildTestAlertEmailHtml(orgName: string): string {
  const org = escapeHtml(orgName)
  const body = dedent`
    <h2>Test alert</h2>
    <p>This is a test alert from Strada to verify your notification setup works.</p>
    <p>If you received this, your alert configuration is working correctly.</p>
    <hr>
    <p class="footer">Strada &middot; ${org}</p>
  `

  return wrapHtml(body)
}
