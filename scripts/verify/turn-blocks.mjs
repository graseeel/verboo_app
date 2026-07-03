import assert from 'node:assert'
import { execFileSync } from 'node:child_process'
execFileSync('npx', ['esbuild', 'src/renderer/features/transcript/turnBlocks.ts',
  '--format=esm', '--bundle', '--platform=node', '--outfile=scripts/verify/_turnblocks.mjs'], { stdio: 'inherit' })
const { groupTurnBlocks, summarizeActions } = await import('./_turnblocks.mjs')

const items = [
  { id: 't:text:1', role: 'assistant', kind: undefined, text: 'Vou investigar.', streaming: false },
  { id: 't:activity:1', role: 'tool', kind: 'activity', activityKind: 'read', text: 'Leu arquivo', activityDetail: 'a.ts' },
  { id: 't:activity:2', role: 'tool', kind: 'activity', activityKind: 'read', text: 'Leu arquivo', activityDetail: 'b.ts' },
  { id: 't:activity:3', role: 'tool', kind: 'activity', activityKind: 'command', text: 'Comando', activityDetail: 'npm run dev' },
  { id: 't:text:2', role: 'assistant', text: 'Encontrei a causa.', streaming: false },
  { id: 't:activity:0', role: 'tool', kind: 'activity', activityKind: 'thinking', text: 'Pensando' },
]
const blocks = groupTurnBlocks(items)
assert.deepEqual(blocks.map(b => b.kind), ['text', 'actions', 'text'], 'thinking ignored; consecutive actions grouped')
assert.equal(blocks[1].actions.length, 3)
assert.equal(summarizeActions(blocks[1].actions), 'Leu arquivos (2) e Executou comando')
assert.equal(blocks[1].actions[2].command.input, 'npm run dev')
console.log('turn-blocks: all assertions passed')
