import {
  Claude,
  DeepSeek,
  Gemini,
  Grok,
  Meta,
  Minimax,
  Mistral,
  Moonshot,
  OpenAI,
  Qwen,
  Zhipu,
} from '@lobehub/icons'
import { Cpu } from 'lucide-react'

type Vendor =
  | 'deepseek' | 'claude' | 'openai' | 'gemini' | 'qwen' | 'zhipu'
  | 'meta' | 'mistral' | 'grok' | 'moonshot' | 'minimax' | 'unknown'

// Official provider logos (via @lobehub/icons) picked from the model id/name.
export function detectModelVendor(modelId: string, displayName?: string): Vendor {
  const haystack = `${modelId} ${displayName ?? ''}`.toLowerCase()
  if (/deepseek/.test(haystack)) return 'deepseek'
  if (/claude|anthropic|sonnet|opus|haiku/.test(haystack)) return 'claude'
  if (/gpt|openai|o[134](?:-mini)?\b|codex/.test(haystack)) return 'openai'
  if (/gemini|gemma|google/.test(haystack)) return 'gemini'
  if (/qwen|qwq/.test(haystack)) return 'qwen'
  if (/glm|zhipu|chatglm/.test(haystack)) return 'zhipu'
  if (/llama|meta/.test(haystack)) return 'meta'
  if (/mistral|mixtral|codestral/.test(haystack)) return 'mistral'
  if (/grok|xai/.test(haystack)) return 'grok'
  if (/kimi|moonshot/.test(haystack)) return 'moonshot'
  if (/minimax|abab/.test(haystack)) return 'minimax'
  return 'unknown'
}

export function ModelIcon({ modelId, displayName, size = 16 }: { modelId: string; displayName?: string; size?: number }) {
  const vendor = detectModelVendor(modelId, displayName)
  switch (vendor) {
    case 'deepseek': return <DeepSeek.Color size={size} />
    case 'claude': return <Claude.Color size={size} />
    case 'openai': return <OpenAI size={size} />
    case 'gemini': return <Gemini.Color size={size} />
    case 'qwen': return <Qwen.Color size={size} />
    case 'zhipu': return <Zhipu.Color size={size} />
    case 'meta': return <Meta.Color size={size} />
    case 'mistral': return <Mistral.Color size={size} />
    case 'grok': return <Grok size={size} />
    case 'moonshot': return <Moonshot size={size} />
    case 'minimax': return <Minimax.Color size={size} />
    default: return <Cpu size={size} />
  }
}
