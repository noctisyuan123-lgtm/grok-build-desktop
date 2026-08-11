// Regenerates the app icon set from the pixel-art "G" master.
//
// The design source is the compact 9x9 bitmap below — an interrupted,
// abstract G with generous negative space. A restrained warm rim makes the
// small mark hold together in the Dock without enlarging the glyph. Rendered
// at 1024x1024 through headless Chrome (integer-aligned
// cells, so edges stay razor sharp), then `tauri icon` derives every
// platform size from the master.
//
// Usage: node scripts/generate_icon.mjs
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';

const root = dirname(dirname(fileURLToPath(import.meta.url)));

// 9x9 pixel grid. '#' = glyph cell. Keep this in sync with BrandGlyph.tsx.
const BITMAP = [
  '.........',
  '..#####..',
  '.##...##.',
  '##.......',
  '##..####.',
  '##....##.',
  '.##...##.',
  '..#####..',
  '.........',
];

const SIZE = 1024;
const CELLS = BITMAP.length; // 9
const CELL = 48; // 432px grid, leaving deliberate breathing room
const OFFSET = (SIZE - CELLS * CELL) / 2; // 296
const BG = '#0E1013';
const GLYPH = '#ECE9E2';
const CORNER = 216;

function buildSvg() {
  const rects = [];
  BITMAP.forEach((row, r) => {
    if (row.length !== CELLS) throw new Error(`row ${r} has ${row.length} cells, want ${CELLS}`);
    [...row].forEach((ch, c) => {
      if (ch === '#') {
        rects.push(
          `<rect x="${OFFSET + c * CELL}" y="${OFFSET + r * CELL}" width="${CELL}" height="${CELL}"/>`,
        );
      }
    });
  });
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="0 0 ${SIZE} ${SIZE}">
  <rect x="18" y="18" width="988" height="988" rx="${CORNER}" fill="${BG}" stroke="${GLYPH}" stroke-opacity="0.82" stroke-width="18"/>
  <g fill="${GLYPH}" shape-rendering="crispEdges">
    ${rects.join('\n    ')}
  </g>
</svg>`;
}

const svg = buildSvg();

const browser = await chromium.launch({
  executablePath:
    process.env.GROK_ICON_CHROMIUM ??
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: true,
  args: ['--no-sandbox', '--force-color-profile=srgb'],
});
try {
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  await page.setContent(
    `<!doctype html><html><body style="margin:0;background:transparent">${svg}</body></html>`,
  );
  const master = join('/tmp', 'grok-pixel-icon-1024.png');
  await page.locator('svg').screenshot({ path: master, omitBackground: true });
  console.log(`master written: ${master}`);
} finally {
  await browser.close();
}

// Derive the full platform set (icns/ico/pngs) into src-tauri/icons/.
const tauri = join(root, 'node_modules', '.bin', 'tauri');
const result = spawnSync(tauri, ['icon', '/tmp/grok-pixel-icon-1024.png'], {
  cwd: root,
  stdio: 'inherit',
});
if (result.status !== 0) process.exit(result.status ?? 1);

// This repository ships desktop bundles only. Tauri's icon command also
// emits mobile assets and an unused 64px PNG, so remove those deterministic
// by-products to keep a regeneration from dirtying the checkout.
rmSync(join(root, 'src-tauri', 'icons', 'android'), { recursive: true, force: true });
rmSync(join(root, 'src-tauri', 'icons', 'ios'), { recursive: true, force: true });
rmSync(join(root, 'src-tauri', 'icons', '64x64.png'), { force: true });
console.log('icon set regenerated in src-tauri/icons/');
