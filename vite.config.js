import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  build: {
    // The PAX A920 Pro card terminal ships Android 10 with a 2020-era system
    // WebView (Chrome 80). Vite's default target emits syntax that engine cannot
    // PARSE — logical assignment (??=, ||=) alone appears 25x — so the bundle died
    // on load and the terminal showed a black screen with no error. Targeting
    // chrome80 transpiles it down. Costs a little bundle size; buys us running on
    // the payment hardware, which is worth far more.
    target: ['chrome80', 'safari14'],
  },
})
