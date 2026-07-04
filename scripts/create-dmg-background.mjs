import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import sharp from 'sharp'

const outputPath = resolve('assets/branding/dmg-background.png')
const sourceMascot = await readFile(resolve('assets/branding/verboo-mascot.png'))
const mascotDataUri = `data:image/png;base64,${sourceMascot.toString('base64')}`
const width = 720
const height = 460

const pattern = [
  { x: 58, y: 72, size: 30, opacity: 0.08, rotate: -11 },
  { x: 166, y: 122, size: 24, opacity: 0.07, rotate: 9 },
  { x: 294, y: 86, size: 22, opacity: 0.06, rotate: -4 },
  { x: 446, y: 118, size: 25, opacity: 0.07, rotate: 13 },
  { x: 600, y: 72, size: 34, opacity: 0.09, rotate: 8 },
  { x: 94, y: 328, size: 42, opacity: 0.09, rotate: 7 },
  { x: 270, y: 356, size: 24, opacity: 0.06, rotate: -8 },
  { x: 436, y: 342, size: 25, opacity: 0.06, rotate: 6 },
  { x: 596, y: 326, size: 36, opacity: 0.08, rotate: -9 },
]

function mascot({ x, y, size, opacity, rotate }) {
  return `<image href="${mascotDataUri}" x="${x}" y="${y}" width="${size}" height="${size}" opacity="${opacity}" transform="rotate(${rotate} ${x + size / 2} ${y + size / 2})"/>`
}

const svg = `
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="background" x1="0" x2="1" y1="0" y2="1">
      <stop offset="0" stop-color="#171923"/>
      <stop offset="0.48" stop-color="#090b12"/>
      <stop offset="1" stop-color="#14101c"/>
    </linearGradient>
    <radialGradient id="purpleGlow" cx="0" cy="0" r="1">
      <stop offset="0" stop-color="#9355ff" stop-opacity="0.34"/>
      <stop offset="0.48" stop-color="#9355ff" stop-opacity="0.12"/>
      <stop offset="1" stop-color="#9355ff" stop-opacity="0"/>
    </radialGradient>
    <radialGradient id="cyanGlow" cx="0" cy="0" r="1">
      <stop offset="0" stop-color="#5ed8ef" stop-opacity="0.24"/>
      <stop offset="0.48" stop-color="#5ed8ef" stop-opacity="0.08"/>
      <stop offset="1" stop-color="#5ed8ef" stop-opacity="0"/>
    </radialGradient>
    <filter id="softBlur">
      <feGaussianBlur stdDeviation="18"/>
    </filter>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#background)"/>
  <circle cx="204" cy="250" r="150" fill="url(#purpleGlow)"/>
  <circle cx="516" cy="250" r="150" fill="url(#cyanGlow)"/>
  <ellipse cx="360" cy="420" rx="260" ry="84" fill="#9355ff" opacity="0.08" filter="url(#softBlur)"/>
  ${pattern.map(mascot).join('\n  ')}

  <g opacity="0.22">
    <circle cx="312" cy="250" r="3.5" fill="#eef1ff"/>
    <circle cx="336" cy="250" r="3.5" fill="#eef1ff"/>
    <circle cx="360" cy="250" r="3.5" fill="#eef1ff"/>
    <circle cx="384" cy="250" r="3.5" fill="#eef1ff"/>
    <circle cx="408" cy="250" r="3.5" fill="#eef1ff"/>
  </g>

  <g opacity="0.82">
    <rect x="120" y="294" width="170" height="40" rx="18" fill="#e7eaf4"/>
    <rect x="444" y="294" width="142" height="40" rx="18" fill="#e7eaf4"/>
  </g>

  <text x="360" y="66" text-anchor="middle" fill="#f3ecff" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="27" font-weight="720">Verboo Code</text>
  <text x="360" y="94" text-anchor="middle" fill="#b6bdd6" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="13" font-weight="560">Drag the app into Applications</text>
</svg>`

await mkdir(dirname(outputPath), { recursive: true })
await writeFile(resolve('assets/branding/dmg-background.svg'), svg.trim(), 'utf8')
await sharp(Buffer.from(svg)).png().toFile(outputPath)
