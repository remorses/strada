// Tinybird browser OAuth flow for the selfhost CLI command.

import { openInBrowser } from "goke";
import dedent from "string-dedent";
import { Spiceflow } from "spiceflow";
import { exchangeTinybirdCliCode } from "./tinybird.ts";

const authServerPort = 49160;
const authHost = "https://cloud.tinybird.co";
const authTimeoutSeconds = 180;

export interface TinybirdAuthResult {
  token: string;
  baseUrl: string;
  workspaceName?: string;
  userEmail?: string;
}

function getCallbackHtml(): string {
  return dedent`<!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="utf-8">
      <meta name="viewport" content="width=device-width, initial-scale=1">
      <title>Strada</title>
      <style>
        *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

        :root {
          --bg: #fafafa;
          --fg: #171717;
          --muted: #737373;
          --border: #e5e5e5;
          --success: #22c55e;
        }

        @media (prefers-color-scheme: dark) {
          :root {
            --bg: #0a0a0a;
            --fg: #ededed;
            --muted: #a3a3a3;
            --border: #262626;
            --success: #4ade80;
          }
        }

        body {
          font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
          background: var(--bg);
          color: var(--fg);
          display: flex;
          align-items: center;
          justify-content: center;
          min-height: 100vh;
          -webkit-font-smoothing: antialiased;
        }

        .container {
          text-align: center;
          max-width: 380px;
          padding: 2rem;
        }

        .icon {
          width: 48px;
          height: 48px;
          margin: 0 auto 1.5rem;
          border-radius: 50%;
          display: flex;
          align-items: center;
          justify-content: center;
          border: 1px solid var(--border);
          background: var(--bg);
          transition: border-color 0.3s, background 0.3s;
        }

        .icon.success {
          border-color: var(--success);
          background: color-mix(in srgb, var(--success) 10%, var(--bg));
        }

        .icon svg {
          width: 24px;
          height: 24px;
          color: var(--muted);
          transition: color 0.3s;
        }

        .icon.success svg { color: var(--success); }

        .spinner {
          width: 24px;
          height: 24px;
          border: 2px solid var(--border);
          border-top-color: var(--fg);
          border-radius: 50%;
          animation: spin 0.8s linear infinite;
        }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }

        h1 {
          font-size: 1.125rem;
          font-weight: 600;
          margin-bottom: 0.5rem;
          letter-spacing: -0.01em;
        }

        p {
          font-size: 0.875rem;
          color: var(--muted);
          line-height: 1.5;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="icon" id="icon">
          <div class="spinner"></div>
        </div>
        <h1 id="title">Authenticating...</h1>
        <p id="message">Connecting to Tinybird</p>
      </div>
      <script>
        const code = new URLSearchParams(location.search).get('code');
        const icon = document.getElementById('icon');
        const title = document.getElementById('title');
        const message = document.getElementById('message');

        const checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg>';
        const errorSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

        if (!code) {
          icon.innerHTML = errorSvg;
          title.textContent = 'Authentication failed';
          message.textContent = 'Missing authorization code. Please try again from the CLI.';
        } else {
          fetch('/?code=' + encodeURIComponent(code), { method: 'POST' })
            .then(() => {
              icon.classList.add('success');
              icon.innerHTML = checkSvg;
              title.textContent = 'Authenticated';
              message.textContent = 'You can close this tab and return to the terminal.';
            })
            .catch(() => {
              icon.innerHTML = errorSvg;
              title.textContent = 'Something went wrong';
              message.textContent = 'Could not complete authentication. Please try again.';
            });
        }
      </script>
    </body>
    </html>`;
}

function createAuthCallbackApp(onCode: (code: string) => void) {
  return new Spiceflow()
    .get("/", () => {
      return new Response(getCallbackHtml(), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    })
    .post("/", ({ request }) => {
      const code = new URL(request.url).searchParams.get("code");
      if (!code) {
        return new Response("Missing code", { status: 400 });
      }

      onCode(code);
      return new Response("", { status: 200 });
    });
}

export async function browserLogin(): Promise<TinybirdAuthResult> {
  let closeServer: (() => void) | null = null;
  let resolveCode!: (code: string) => void;
  let rejectCode!: (error: Error) => void;

  const codePromise = new Promise<string>((resolve, reject) => {
    resolveCode = resolve;
    rejectCode = reject;
  });

  const app = createAuthCallbackApp((code) => {
    resolveCode(code);
  });

  const timeout = setTimeout(() => {
    rejectCode(new Error(`Authentication timed out after ${authTimeoutSeconds}s`));
  }, authTimeoutSeconds * 1000);

  try {
    const listeningServer = await app.listen(authServerPort, "127.0.0.1");
    closeServer = () => {
      const server: { stop?: () => void; close?: () => void } = listeningServer.server;
      if (typeof server.stop === "function") {
        server.stop();
      } else if (typeof server.close === "function") {
        server.close();
      }
    };

    const authUrl = new URL("/api/cli-login", authHost);
    authUrl.searchParams.set("origin", "ts-sdk");
    void openInBrowser(authUrl.toString());

    const code = await codePromise;
    const tokens = await exchangeTinybirdCliCode({ authHost, code });

    return {
      token: tokens.workspace_token,
      baseUrl: tokens.api_host,
      ...(tokens.workspace_name !== undefined ? { workspaceName: tokens.workspace_name } : undefined),
      ...(tokens.user_email !== undefined ? { userEmail: tokens.user_email } : undefined),
    };
  } finally {
    clearTimeout(timeout);
    if (closeServer) {
      closeServer();
    }
  }
}
