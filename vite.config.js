import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VERSION } from './src/lib/version.js'

// v5.5.870: emit dist/version.json ({ "version": "x.y.z" }) alongside the build. Devices poll it
// (cache-busted) and force-update themselves when the deployed version is newer than the running
// one — so a till (esp. the Sunmi WebView, which keeps old code in memory on a mere refresh) can
// never silently run stale code. See src/components/UpdateGuard.jsx.
const emitVersionJson = () => ({
  name: 'emit-version-json',
  generateBundle() {
    this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ version: VERSION }) })
  },
})

export default defineConfig({
  plugins: [react(), emitVersionJson()],
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
