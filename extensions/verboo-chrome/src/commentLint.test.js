/**
 * commentLint.test.js — B-6/B-7 (Farol): comentários citam SÍMBOLOS, nunca
 * linhas. Referências do tipo nomeDeArquivo + numeroDeLinha em comentários
 * quebram quando o código muda (a classe já falhou 2x no gate). Este lint
 * falha se o padrão arquivo.ponto.j + dois-pontos + dígito aparecer em
 * qualquer arquivo .js de src/.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)))

/** @param {string} dir @returns {string[]} */
function listJsFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      out.push(...listJsFiles(full))
    } else if (entry.endsWith('.js')) {
      out.push(full)
    }
  }
  return out
}

// N4/R2: extrai SOMENT partes de comentário (// ou /* */) de uma linha.
// Ignora strings, template literals e código. Retorna as partes de comentário.
function extractCommentParts(line, state) {
  const parts = []
  let rest = line
  // Se estamos dentro de um bloco /* */, tudo até */ é comentário.
  if (state.inBlock) {
    const endIdx = rest.indexOf('*/')
    if (endIdx >= 0) {
      parts.push(rest.slice(0, endIdx + 2))
      rest = rest.slice(endIdx + 2)
      state.inBlock = false
    } else {
      parts.push(rest)
      return parts
    }
  }
  // Comentários de linha // (ignora dentro de strings — simplificação: se
  // o // está depois de uma string não fechada, é código; mas para um lint
  // de segurança, aceitar falsos positivos é melhor que falsos negativos).
  const slashIdx = rest.indexOf('//')
  if (slashIdx >= 0) {
    parts.push(rest.slice(slashIdx))
    rest = rest.slice(0, slashIdx)
  }
  // Blocos /* */ inline
  let searchFrom = 0
  for (;;) {
    const blockStart = rest.indexOf('/*', searchFrom)
    if (blockStart < 0) break
    const blockEnd = rest.indexOf('*/', blockStart + 2)
    if (blockEnd >= 0) {
      parts.push(rest.slice(blockStart, blockEnd + 2))
      searchFrom = blockEnd + 2
    } else {
      parts.push(rest.slice(blockStart))
      state.inBlock = true
      break
    }
  }
  return parts
}

// Allow-list: arquivos que podem conter .js:\d+ em comentários (justificado).
const ALLOWED_FILES = new Set([
  'commentLint.test.js', // o próprio lint documenta o padrão que caça.
])

test('B-6/B-7: nenhum comentário cita arquivo:linha (\\.js:\\d+) em src/', () => {
  const offenders = []
  for (const file of listJsFiles(SRC_DIR)) {
    const fileName = file.replace(/^.*\//, '')
    if (ALLOWED_FILES.has(fileName)) continue
    const lines = readFileSync(file, 'utf8').split('\n')
    const state = { inBlock: false }
    lines.forEach((line, i) => {
      const commentParts = extractCommentParts(line, state)
      for (const part of commentParts) {
        if (/\.js:\d+/.test(part)) {
          offenders.push(`${file.replace(SRC_DIR + '/', '')}:${i + 1}: ${part.trim()}`)
        }
      }
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'Comentários devem citar SÍMBOLOS, nunca arquivo:linha. Ofensores:\n' + offenders.join('\n'),
  )
})