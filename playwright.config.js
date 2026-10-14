import { defineConfig } from "@playwright/test";
import { fakeCameraFile } from "./e2e/fixtures/fakeCamera.js";

// Own port: vite.config.js pins 3000 (strictPort) for `tauri dev`, and a dev
// session running there must not collide with, or be reused by, the e2e run.
const PORT = 3100;

export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.js",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    // Installed Edge (WebView2 is Chromium-based) — no browser download needed.
    // Set E2E_BROWSER=chromium to use Playwright's own build instead.
    channel: process.env.E2E_BROWSER === "chromium" ? undefined : "msedge",
    headless: true,
    trace: "retain-on-failure",
  },
  projects: [
    { name: "app", testIgnore: "**/camera.e2e.js" },
    {
      // Chromium plays a generated video file as the webcam (fixtures/fakeCamera.js).
      // A project of its own: launch flags apply to the whole browser.
      name: "camera",
      testMatch: "**/camera.e2e.js",
      use: {
        launchOptions: {
          args: [
            "--use-fake-device-for-media-stream",
            `--use-file-for-fake-video-capture=${fakeCameraFile()}`,
          ],
        },
      },
    },
  ],
  webServer: {
    // Production bundle, not the dev server: Vite dev serves ~150 unbundled
    // modules per page load (~5s here, paid by every test's fresh context).
    // The build takes ~3s once and is also what ships.
    command: `npx vite build --outDir dist-e2e && npx vite preview --outDir dist-e2e --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    // Never reuse: a leftover server would serve a stale bundle.
    reuseExistingServer: false,
    timeout: 60_000,
    stdout: "ignore",
    stderr: "pipe",
  },
});
