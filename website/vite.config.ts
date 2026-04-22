import { cloudflare } from '@cloudflare/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { spiceflowPlugin } from 'spiceflow/vite'

const port = parseInt(process.env.PORT || '5199', 10)

export default defineConfig({
  server: { port, strictPort: true },
  clearScreen: false,
  plugins: [
    react(),
    spiceflowPlugin({ entry: './src/app.tsx' }),
    cloudflare({
      viteEnvironment: {
        name: 'rsc',
        childEnvironments: ['ssr'],
      },
    }),
  ],
})
