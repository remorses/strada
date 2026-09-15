import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { holocron } from '@holocron.so/vite'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

const port = parseInt(process.env.PORT || '5444', 10)

export default defineConfig(async () => {
  const migrations = await readD1Migrations(path.join(__dirname, '..', 'db', 'drizzle')).catch(() => [])

  return {
    server: { port, strictPort: true },
    clearScreen: false,
    resolve: {
      alias: {
        '@ui': path.resolve(__dirname, 'src/ui'),
      },
      dedupe: ['spiceflow', 'spiceflow/react', 'react', 'react-dom', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
    },

    plugins: [
      // cloudflareTest() runs tests inside workerd via @cloudflare/vitest-pool-workers.
      // cloudflare() handles dev/build/deploy but conflicts with the vitest pool
      // (both manage workerd), so only one is active at a time.
      process.env.VITEST
        ? cloudflareTest({
            wrangler: { configPath: './wrangler.jsonc' },
            main: './src/test-worker-entrypoint.ts',
            miniflare: {
              bindings: {
                TEST_MIGRATIONS: migrations,
                BETTER_AUTH_SECRET: 'test-secret-that-is-at-least-32-characters-long',
                BETTER_AUTH_URL: 'http://localhost',
                GOOGLE_CLIENT_ID: 'test-google-client',
                GOOGLE_CLIENT_SECRET: 'test-google-secret',
                STRADA_TOKEN: 'test-strada-token',
              },
            },
          })
        : null,
      // In test mode: use raw plugins (holocron auto-adds react+tailwind+spiceflow
      // which conflicts with cloudflareTest). In dev/build: use holocron.
      ...(process.env.VITEST
        ? [react(), spiceflowPlugin({ entry: './src/app.tsx' }), tailwindcss()]
        : [holocron({ entry: './src/app.tsx', pagesDir: './src' })]),
      // cloudflare() must come AFTER spiceflow/holocron — spiceflow sets ssr outDir to
      // dist/rsc/ssr (nested inside the worker root) so workerd can resolve the
      // cross-environment import. cloudflare's config hook unconditionally sets
      // outDir to dist/ssr (sibling), and Vite's config merge gives the first
      // setter priority.
      !process.env.VITEST
        ? cloudflare({
            viteEnvironment: {
              name: 'rsc',
              childEnvironments: ['ssr'],
            },
          })
        : null,
    ],
    test: {
      setupFiles: ['./src/apply-migrations.ts'],
    },
  }
})
