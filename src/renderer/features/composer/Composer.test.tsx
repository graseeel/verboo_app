import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup, act } from '@testing-library/react'
import type { Annotation, AttachmentMeta, SkillSummary } from '../../../shared/types'

// jsdom lacks matchMedia — Composer reads it at module-eval time for
// prefers-reduced-motion. Stub before importing Composer.
if (!window.matchMedia) {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }),
  })
}

import { Composer } from './Composer'

// ── Mocks ──────────────────────────────────────────────────────────────
vi.mock('../../i18n', () => ({
  useI18n: () => ({ t: (k: string) => k, language: 'en-US' as const }),
}))
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: () => {} }) }))
vi.mock('../queue/QueuePanel', () => ({ QueuePanel: () => null }))
vi.mock('../plugins/PluginCard', () => ({ PluginIcon: ({ name }: { name: string }) => <span data-icon>{name}</span> }))
vi.mock('./voiceInput', () => ({
  createVoiceInput: () => ({ start: () => {}, stop: () => {}, destroy: () => {} }),
  detectSupport: () => false,
  applyVoiceInterim: (c: string) => c,
  commitVoiceFinal: (c: string) => c,
  nextCatchUpStep: () => null,
}))

if (!('innerHeight' in window) || (window as any).innerHeight === 0) {
  Object.defineProperty(window, 'innerHeight', { value: 800, writable: true })
}

beforeEach(() => cleanup())

// ── Helpers ─────────────────────────────────────────────────────────────
type ComposerProps = React.ComponentProps<typeof Composer>

const baseSkill: SkillSummary = {
  id: 'skill:brainstorming',
  name: 'brainstorming',
  description: 'Brainstorm ideas before building',
  path: '/skills/brainstorming/SKILL.md',
  source: 'managed',
  trusted: true,
}

const pluginSkill: SkillSummary = {
  ...baseSkill,
  id: 'plugin:superpowers:brainstorming',
  pluginId: 'superpowers',
  pluginName: 'superpowers',
}

function renderComposer(overrides: Partial<ComposerProps> = {}) {
  const props: ComposerProps = {
    disabled: false,
    skills: [baseSkill, pluginSkill],
    tokenSkills: [],
    onTokenSkillsChange: vi.fn(),
    attachments: [],
    onAttachFiles: vi.fn(),
    onDropFiles: vi.fn(),
    onRemoveAttachment: vi.fn(),
    onSubmit: vi.fn(),
    onPasteFiles: vi.fn(),
    onGoalCommand: vi.fn(),
    onPetCommand: vi.fn(),
    onCompactCommand: vi.fn(),
    leftToolbar: null,
    rightToolbar: null,
    ...overrides,
  } as ComposerProps
  return { ...render(<Composer {...props} />), props }
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('t1 — @ palette inserts inline token', () => {
  it('selects skill from @ palette → inserts @<name> in text and palette closes', () => {
    let value = '@'
    const onValueChange = vi.fn(v => { value = v })

    renderComposer({ value, onValueChange })

    // @ palette open — portal in document.body
    const option = document.body.querySelector('.skill-option') as HTMLButtonElement
    expect(option).toBeTruthy()
    expect(option.textContent).toContain('brainstorming')

    fireEvent.click(option)

    // onValueChange called with @brainstorming (replaceAtQueryWithToken)
    expect(onValueChange).toHaveBeenCalled()
    const newVal = onValueChange.mock.calls[0][0] as string
    expect(newVal).toMatch(/@brainstorming/)
    expect(newVal).not.toMatch(/\s@$/)
  })
})

describe('t2 — syncTokenSkills: / and @ tokens', () => {
  it('typing @brainstorming calls onTokenSkillsChange with matched skill', () => {
    const onTokenSkillsChange = vi.fn()

    const { container } = renderComposer({
      value: 'use @brainstorming',
      onTokenSkillsChange,
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'use @brainstorming now' } })

    // syncTokenSkills fires with the @-matched skill
    expect(onTokenSkillsChange).toHaveBeenCalled()
    const skills = onTokenSkillsChange.mock.calls[0][0] as SkillSummary[]
    expect(skills.some(s => s.name === 'brainstorming')).toBe(true)
  })

  it('deleting @token from text → onTokenSkillsChange excludes it', () => {
    const onTokenSkillsChange = vi.fn()

    const { container } = renderComposer({
      value: 'use @brainstorming',
      tokenSkills: [baseSkill],
      onTokenSkillsChange,
    })

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: 'use ' } })

    // syncTokenSkills fires with empty array (no tokens left)
    expect(onTokenSkillsChange).toHaveBeenCalled()
    const skills = onTokenSkillsChange.mock.calls[0][0] as SkillSummary[]
    expect(skills).toHaveLength(0)
  })
})

describe('video attachment chip', () => {
  it('shows name, duration, size, and remove action without an unreadable warning', () => {
    const video: AttachmentMeta = {
      path: '/uploads/clip.mp4',
      name: 'clip.mp4',
      size: 1_572_864,
      kind: 'video',
      video: {
        durationMs: 65_000,
        container: 'mp4',
        videoCodec: 'h264',
        width: 16,
        height: 16,
        avgFps: 1,
        hasAudio: true,
        hdr: 'sdr',
      },
    }
    const onRemoveAttachment = vi.fn()
    renderComposer({ attachments: [video], onRemoveAttachment })

    const chip = screen.getByRole('button', { name: /clip\.mp4/i })
    expect(chip.textContent).toContain('1:05 · 1.5 MB')
    expect(chip.textContent).not.toContain('composer.attachmentUnreadable')
    fireEvent.click(chip)
    expect(onRemoveAttachment).toHaveBeenCalledWith('/uploads/clip.mp4')
  })
})

describe('t3 — dedupe /name + @name same skill → 1 entry', () => {
  it('text with /brainstorming and @brainstorming → onTokenSkillsChange gives 1 entry (same skill id)', () => {
    const singleSkill: SkillSummary = {
      id: 's1', name: 'dedupe-skill',
      description: 'dedupe', path: '/s1', source: 'managed', trusted: true,
    }
    const onTokenSkillsChange = vi.fn()

    const { container } = renderComposer({
      value: '',
      skills: [singleSkill],
      onTokenSkillsChange,
    })

    // Fire change with / and @ tokens for the same skill name
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement
    fireEvent.change(textarea, { target: { value: '/dedupe-skill and @dedupe-skill both' } })

    // Both tokens match 'dedupe-skill' → combined Set has 1 name → filter
    // returns the single matching skill (1 entry, not 2).
    expect(onTokenSkillsChange).toHaveBeenCalled()
    const skills = onTokenSkillsChange.mock.calls[0][0] as SkillSummary[]
    expect(skills.filter(s => s.name === 'dedupe-skill')).toHaveLength(1)
  })
})

describe('t4 — submit clears tokenSkills', () => {
  it('submit calls onSubmit and onTokenSkillsChange([])', () => {
    const onSubmit = vi.fn()
    const onTokenSkillsChange = vi.fn()

    const { container } = renderComposer({
      value: 'ship it now',
      tokenSkills: [baseSkill],
      onSubmit,
      onTokenSkillsChange,
    })

    const form = container.querySelector('form') as HTMLFormElement
    fireEvent.submit(form)

    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit.mock.calls[0][0]).toBe('ship it now')
    expect(onTokenSkillsChange).toHaveBeenCalledWith([])
  })

  it('submits a browser annotation without requiring extra composer text', () => {
    const annotation: AttachmentMeta = {
      path: '/tmp/browser-element.png',
      name: 'browser-element.png',
      size: 1,
      kind: 'browser-annotation',
      mediaType: 'image/png',
      browserAnnotation: {
        kind: 'element',
        crop: '/tmp/browser-element.png',
        url: 'http://localhost:5173',
        selector: '#hero-cta',
        note: 'Use a cyan border',
        rect: { x: 1, y: 2, width: 3, height: 4 },
        viewport: { width: 800, height: 600 },
      },
    }
    const onSubmit = vi.fn()
    const { container } = renderComposer({ attachments: [annotation], onSubmit })

    expect(screen.getByRole('button', { name: 'browser.annotationElement · #hero-cta' })).toBeVisible()
    expect(container.querySelector<HTMLButtonElement>('.send-button')).not.toBeDisabled()
    fireEvent.submit(container.querySelector('form')!)

    expect(onSubmit).toHaveBeenCalledWith('browser.annotationDefaultPrompt')
  })

  it('submits a simulator annotation without requiring extra composer text', () => {
    const annotation: AttachmentMeta = {
      path: '/tmp/verboo-ios-simulator/crop.png',
      name: 'simulator-element.png',
      size: 1,
      kind: 'simulator-annotation',
      mediaType: 'image/png',
      simulatorAnnotation: {
        kind: 'element',
        crop: '/tmp/verboo-ios-simulator/crop.png',
        device: { name: 'iPhone 17 Pro', udid: 'phone', iosVersion: '26.5', orientation: 'portrait' },
        deviceGeneration: 1,
        frameGeneration: 2,
        rect: { x: 0.1, y: 0.2, width: 0.3, height: 0.1 },
        deviceRect: { x: 39, y: 170, width: 118, height: 85 },
        element: { id: 'save', role: 'Button', label: 'Save' },
        viewportSnapshot: { path: '/tmp/verboo-ios-simulator/full.png', width: 393, height: 852, size: 2 },
      },
    }
    const onSubmit = vi.fn()
    const { container } = renderComposer({ attachments: [annotation], onSubmit })

    expect(screen.getByRole('button', { name: 'simulator.annotationElement · Save' })).toBeVisible()
    expect(container.querySelector<HTMLButtonElement>('.send-button')).not.toBeDisabled()
    fireEvent.submit(container.querySelector('form')!)

    expect(onSubmit).toHaveBeenCalledWith('simulator.annotationDefaultPrompt')
  })
})

describe('t5 — overlay: @token with PluginIcon', () => {
  it('renderHighlightedValue @token of plugin skill → at-glyph contains icon decoration', () => {
    const { container } = renderComposer({
      value: '@brainstorming',
      skills: [pluginSkill, baseSkill],
    })

    const highlight = container.querySelector('.composer-highlight')
    expect(highlight).toBeTruthy()
    const token = highlight!.querySelector('.composer-skill-token')
    expect(token).toBeTruthy()
    expect(token!.textContent).toContain('brainstorming')

    // @token has .at-glyph (hidden @, preserves inline width for caret)
    const glyph = token!.querySelector('.at-glyph')
    expect(glyph).toBeTruthy()
    expect(glyph!.textContent).toContain('@')

    // pluginSkill has pluginId → .at-icon-deco renders INSIDE the glyph box
    // (child, not sibling) so the icon anchors to the glyph's right edge.
    const deco = glyph!.querySelector('.at-icon-deco')
    expect(deco).toBeTruthy()
    expect(deco!.parentElement).toBe(glyph)
    const icon = deco!.querySelector('[data-icon]')
    expect(icon).toBeTruthy()
  })

  it('/token does NOT contain at-glyph or icon decoration', () => {
    const { container } = renderComposer({
      value: '/brainstorming',
      skills: [baseSkill, pluginSkill],
    })

    const highlight = container.querySelector('.composer-highlight')
    expect(highlight).toBeTruthy()
    const tokenSpan = highlight!.querySelector('.composer-skill-token')
    expect(tokenSpan).toBeTruthy()
    // /tokens never get at-glyph or PluginIcon
    expect(tokenSpan!.querySelector('.at-glyph')).toBeFalsy()
    expect(tokenSpan!.querySelector('.at-icon-deco')).toBeFalsy()
    expect(tokenSpan!.querySelector('[data-icon]')).toBeFalsy()
  })

  it('@token overlay has identical font metrics to textarea (no font-weight on token)', () => {
    // BUG A regression guard: the overlay MUST NOT set font-weight (or any
    // metric-changing property) on .composer-skill-token. Any divergence
    // makes the painted text drift vs. the textarea's caret. jsdom doesn't
    // load CSS, so we assert the inline-style contract: the token span has
    // NO inline font-weight, letter-spacing, or font-style override.
    const { container } = renderComposer({
      value: '@brainstorming',
      skills: [pluginSkill, baseSkill],
    })

    const token = container.querySelector('.composer-skill-token')! as HTMLElement
    // No inline metric-changing styles on the token itself
    expect(token.style.fontWeight).toBe('')
    expect(token.style.letterSpacing).toBe('')
    expect(token.style.fontStyle).toBe('')
  })

  it('@token without pluginId has no icon decoration (plain accent text)', () => {
    const { container } = renderComposer({
      value: '@brainstorming',
      skills: [baseSkill, pluginSkill],
    })

    const token = container.querySelector('.composer-skill-token')!
    // baseSkill has no pluginId → no .at-icon-deco rendered
    expect(token.querySelector('.at-icon-deco')).toBeFalsy()
    // but the @ glyph is still there (preserves caret alignment)
    expect(token.querySelector('.at-glyph')).toBeTruthy()
  })
})

// ── Native drag overlay ─────────────────────────────────────────────────
// Tauri relays window-level 'enter'/'over'/'leave'/'drop' as DOM CustomEvents.
// 'over' repeats for every pointer move, so it must not feed a nesting
// counter — otherwise one 'leave' can never undo N increments.
function nativeDrag(type: string, paths: string[] = []) {
  act(() => {
    window.dispatchEvent(new CustomEvent('verboo:drag-event', { detail: { type, paths } }))
  })
}

describe('native drag overlay', () => {
  it('shows the overlay while a native drag hovers the composer', () => {
    const { container } = renderComposer()
    nativeDrag('enter', ['/tmp/clip.mov'])
    expect(container.querySelector('.composer-drop-overlay')).toBeTruthy()
  })

  it('hides the overlay when the drag is abandoned after many over events', () => {
    const { container } = renderComposer()

    nativeDrag('enter', ['/tmp/clip.mov'])
    for (let i = 0; i < 12; i += 1) nativeDrag('over')
    nativeDrag('leave')

    expect(container.querySelector('.composer-drop-overlay')).toBeFalsy()
  })

  it('hides the overlay after a drop', () => {
    const onDropFiles = vi.fn()
    const { container } = renderComposer({ onDropFiles })

    nativeDrag('enter', ['/tmp/clip.mov'])
    for (let i = 0; i < 5; i += 1) nativeDrag('over')
    nativeDrag('drop', ['/tmp/clip.mov'])

    expect(container.querySelector('.composer-drop-overlay')).toBeFalsy()
    expect(onDropFiles).toHaveBeenCalledWith(['/tmp/clip.mov'], [])
  })
})

describe('F3 — annotation chip enables annotation-ONLY send', () => {
  const transcriptAnnotation: Annotation = {
    id: 'ann-1',
    segmentId: 'turn1:text:0',
    quote: 'the selected excerpt',
    prefix: '',
    suffix: '',
    occurrenceIndex: 0,
    comment: 'please fix this',
    createdAt: 1_700_000_000_000,
  }

  it('EFFECT: annotations + EMPTY text → send enabled, and the submit ships an EMPTY message', () => {
    const onSubmit = vi.fn()
    const { container } = renderComposer({ value: '', annotations: [transcriptAnnotation], onSubmit })

    expect(container.querySelector<HTMLButtonElement>('.send-button')).not.toBeDisabled()
    fireEvent.submit(container.querySelector('form')!)

    // The message travels EMPTY — the annotation IS the content (the field is
    // attached downstream, in App). The composer must NOT invent a prompt for
    // this case, unlike browser-annotation which legitimately has one.
    expect(onSubmit).toHaveBeenCalledTimes(1)
    expect(onSubmit).toHaveBeenCalledWith('')
  })

  it('CONTRAFACTUAL (single variable): the SAME setup WITHOUT annotations → send disabled, submit is a no-op', () => {
    const onSubmit = vi.fn()
    const { container } = renderComposer({ value: '', onSubmit })

    expect(container.querySelector<HTMLButtonElement>('.send-button')).toBeDisabled()
    fireEvent.submit(container.querySelector('form')!)
    expect(onSubmit).not.toHaveBeenCalled()
  })
})
