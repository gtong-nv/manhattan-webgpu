import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 180000,
  expect: { timeout: 60000 },
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL || 'http://127.0.0.1:5174',
    viewport: { width: 1440, height: 1000 },
    headless: process.env.PLAYWRIGHT_HEADFUL !== '1',
    launchOptions: {
      ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : { channel: 'chromium' }),
      args: ['--no-sandbox', '--enable-unsafe-webgpu', ...(process.env.CHROMIUM_GPU_FLAGS?.split(' ') || ['--use-angle=swiftshader'])],
    },
    screenshot: 'only-on-failure',
  },
  webServer: { command: 'npm run dev -- --port 5174 --strictPort', url: 'http://127.0.0.1:5174', reuseExistingServer: true },
});
