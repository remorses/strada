import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

const port = parseInt(process.env.PORT || '5444', 10)

export default defineConfig({
  server: { port, strictPort: true },
  clearScreen: false,
  resolve: {
    alias: {
      '@ui': path.resolve(__dirname, 'src/ui'),
    },
  },

  plugins: [
    react(),
    spiceflowPlugin({ entry: './src/app.tsx' }),
    tailwindcss(),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
})
