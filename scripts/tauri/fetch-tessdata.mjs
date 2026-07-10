#!/usr/bin/env node

/**
 * scripts/tauri/fetch-tessdata.mjs
 *
 * Downloads eng+por traineddata files for tesseract.js and places them in
 * the renderer's public directory so they're bundled with the app.
 *
 * Idempotent — skips files that already exist (based on filename).
 * Run via: npm run fetch:tessdata
 * Or automatically as part of build:tauri-deps.
 */

import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { access, mkdir } from 'node:fs/promises'
import { get } from 'node:https'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const TESSDATA_DIR = resolve(__dirname, '../../src/renderer/public/tessdata')

const LANGUAGES = [
  { lang: 'eng', url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/eng/4.0.0_best_int/eng.traineddata.gz' },
  { lang: 'por', url: 'https://cdn.jsdelivr.net/npm/@tesseract.js-data/por/4.0.0_best_int/por.traineddata.gz' },
]

async function download(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = createWriteStream(destPath)
    get(url, response => {
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        // Follow redirect
        file.close()
        download(response.headers.location, destPath).then(resolve).catch(reject)
        return
      }
      if (response.statusCode !== 200) {
        file.close()
        reject(new Error(`HTTP ${response.statusCode} for ${url}`))
        return
      }
      response.pipe(file)
      file.on('finish', () => { file.close(); resolve() })
    }).on('error', err => { file.close(); reject(err) })
  })
}

async function main() {
  mkdirSync(TESSDATA_DIR, { recursive: true })
  for (const { lang, url } of LANGUAGES) {
    // Traineddata files stored without the .gz extension — tesseract.js
    // detects gzip magic bytes and decompresses via zlibjs automatically.
    const dest = resolve(TESSDATA_DIR, `${lang}.traineddata`)
    if (existsSync(dest)) {
      console.log(`[fetch:tessdata] ${lang}.traineddata already exists, skipping`)
      continue
    }
    console.log(`[fetch:tessdata] Downloading ${lang}.traineddata.gz...`)
    await download(url, dest)
    const size = (await import('node:fs')).statSync(dest).size
    console.log(`[fetch:tessdata] ${lang}.traineddata downloaded (${(size / 1024 / 1024).toFixed(1)} MB)`)
  }
  console.log('[fetch:tessdata] Done')
}

main().catch(err => {
  console.error('[fetch:tessdata] Failed:', err.message)
  process.exit(1)
})
