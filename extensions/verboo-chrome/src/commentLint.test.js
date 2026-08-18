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

test('B-6/B-7: nenhum comentário cita arquivo:linha (\\.js:\\d+) em src/', () => {
  const offenders = []
  for (const file of listJsFiles(SRC_DIR)) {
    const lines = readFileSync(file, 'utf8').split('\n')
    lines.forEach((line, i) => {
      if (/\.js:\d+/.test(line)) {
        offenders.push(`${file.replace(SRC_DIR + '/', '')}:${i + 1}: ${line.trim()}`)
      }
    })
  }
  assert.deepEqual(
    offenders,
    [],
    'Comentários devem citar SÍMBOLOS, nunca arquivo:linha. Ofensores:\n' + offenders.join('\n'),
  )
})