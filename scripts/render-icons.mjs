// Render the PNG icons from the SVGs written by scripts/icons.py.
// Requires Playwright with a Chromium/Chrome browser:
//   npx playwright install chromium   (or set CHROME_PATH to an installed Chrome)
//   python3 scripts/icons.py && node scripts/render-icons.mjs
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = process.env.ICON_DIR || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'icons');
const jobs = [
  ['icon.svg', 'icon-512.png', 512],
  ['icon.svg', 'icon-192.png', 192],
  ['icon.svg', 'apple-touch-icon.png', 180],
  ['icon-maskable.svg', 'icon-maskable-512.png', 512],
  ['favicon.svg', 'favicon-32.png', 32],
];
const browser = await chromium.launch(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : {});
const page = await browser.newPage();
for (const [source, target, size] of jobs) {
  const svg = fs.readFileSync(path.join(dir, source), 'utf8').replace('<svg ', `<svg width="${size}" height="${size}" `);
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg}</body></html>`);
  await page.locator('svg').screenshot({ path: path.join(dir, target), omitBackground: true });
  console.log('wrote', target);
}
await browser.close();
