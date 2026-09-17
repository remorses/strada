import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import spiceflow from 'spiceflow/vite'

export default defineConfig({
  server: { port: 5291, strictPort: true },
  clearScreen: false,
  plugins: [spiceflow({ entry: './src/main.tsx' }), react(), tailwindcss()],
})
