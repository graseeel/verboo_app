import { ArrowLeft, ArrowRight, Check, MessageCircleQuestion, Send, X } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { useI18n } from '../../i18n'

export type ModelQuestionOption = {
  label: string
  description?: string
}

export type ModelQuestion = {
  header?: string
  question: string
  multiSelect?: boolean
  options: ModelQuestionOption[]
}

export type QuestionAnswer = {
  selected: string[]
  custom: string
}

export type QuestionPromptState = {
  conversationId: string
  turnId: string
  questions: ModelQuestion[]
  answers: QuestionAnswer[]
}

type QuestionWizardProps = {
  prompt: QuestionPromptState
  onAnswersChange: (answers: QuestionAnswer[]) => void
  onSubmit: () => void
  onDismiss: () => void
}

const AUTO_ADVANCE_DELAY = 170

// One question at a time, sliding between steps. Picking a single-select chip
// answers AND advances on its own; typed answers and multi-select advance via
// the arrow. Skipping is allowed — unanswered questions ship as "no answer".
export function QuestionWizard({ prompt, onAnswersChange, onSubmit, onDismiss }: QuestionWizardProps) {
  const { t } = useI18n()
  const [index, setIndex] = useState(0)
  const [direction, setDirection] = useState<'forward' | 'back'>('forward')
  const [flashing, setFlashing] = useState<string | undefined>()
  const advanceTimer = useRef<number>(undefined)

  const total = prompt.questions.length
  const safeIndex = Math.min(index, total - 1)
  const question = prompt.questions[safeIndex]
  const answer = prompt.answers[safeIndex] ?? { selected: [], custom: '' }
  const answeredCount = prompt.answers.filter(entry => entry && (entry.selected.length > 0 || entry.custom.trim())).length
  const isLast = safeIndex === total - 1

  useEffect(() => () => window.clearTimeout(advanceTimer.current), [])

  function patchAnswer(patch: Partial<QuestionAnswer>) {
    const next = prompt.answers.slice()
    next[safeIndex] = { ...answer, ...patch }
    onAnswersChange(next)
  }

  function goTo(nextIndex: number, dir: 'forward' | 'back') {
    setDirection(dir)
    setIndex(Math.max(0, Math.min(total - 1, nextIndex)))
  }

  function advance() {
    if (isLast) onSubmit()
    else goTo(safeIndex + 1, 'forward')
  }

  function pickOption(label: string) {
    if (question.multiSelect) {
      const selected = answer.selected.includes(label)
        ? answer.selected.filter(item => item !== label)
        : [...answer.selected, label]
      patchAnswer({ selected })
      return
    }
    patchAnswer({ selected: [label] })
    // Brief selection flash before sliding on — picking should feel like a
    // click that lands, not a teleport.
    setFlashing(label)
    window.clearTimeout(advanceTimer.current)
    advanceTimer.current = window.setTimeout(() => {
      setFlashing(undefined)
      advance()
    }, AUTO_ADVANCE_DELAY)
  }

  function handleCustomKeyDown(event: React.KeyboardEvent) {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      advance()
    }
  }

  return (
    <section className="question-wizard" role="dialog" aria-label={t('questions.title')}>
      <header className="question-wizard-head">
        <span className="question-wizard-title">
          <MessageCircleQuestion size={15} aria-hidden="true" />
          {t('questions.title')}
        </span>
        <span className="question-wizard-progress">
          {t('questions.progress', { current: safeIndex + 1, total, answered: answeredCount })}
        </span>
        <button type="button" className="question-wizard-close" onClick={onDismiss} title={t('questions.dismiss')} aria-label={t('questions.dismiss')}>
          <X size={14} />
        </button>
      </header>

      <div className="question-wizard-track">
        <div key={safeIndex} className={`question-wizard-step ${direction === 'forward' ? 'from-right' : 'from-left'}`}>
          {question.header && <span className="question-step-header">{question.header}</span>}
          <p className="question-step-question">{question.question}</p>

          {question.options.length > 0 && (
            <div className="question-step-options" role={question.multiSelect ? 'group' : 'radiogroup'}>
              {question.options.map(option => {
                const active = answer.selected.includes(option.label)
                return (
                  <button
                    key={option.label}
                    type="button"
                    role={question.multiSelect ? 'checkbox' : 'radio'}
                    aria-checked={active}
                    className={`question-option ${active ? 'selected' : ''} ${flashing === option.label ? 'flashing' : ''}`}
                    onClick={() => pickOption(option.label)}
                  >
                    <span className="question-option-check" aria-hidden="true">{active && <Check size={12} />}</span>
                    <span className="question-option-copy">
                      <strong>{option.label}</strong>
                      {option.description && <small>{option.description}</small>}
                    </span>
                  </button>
                )
              })}
            </div>
          )}

          <textarea
            className="question-step-custom"
            value={answer.custom}
            placeholder={question.options.length > 0 ? t('questions.customPlaceholder') : t('questions.freePlaceholder')}
            rows={question.options.length > 0 ? 1 : 3}
            onChange={event => patchAnswer({ custom: event.target.value })}
            onKeyDown={handleCustomKeyDown}
          />
        </div>
      </div>

      <footer className="question-wizard-foot">
        <button
          type="button"
          className="question-nav-button"
          disabled={safeIndex === 0}
          onClick={() => goTo(safeIndex - 1, 'back')}
          aria-label={t('questions.previous')}
        >
          <ArrowLeft size={15} />
        </button>
        <div className="question-wizard-dots" aria-hidden="true">
          {prompt.questions.map((_, dotIndex) => {
            const entry = prompt.answers[dotIndex]
            const answered = Boolean(entry && (entry.selected.length > 0 || entry.custom.trim()))
            return (
              <button
                key={dotIndex}
                type="button"
                tabIndex={-1}
                className={`question-dot ${dotIndex === safeIndex ? 'current' : ''} ${answered ? 'answered' : ''}`}
                onClick={() => goTo(dotIndex, dotIndex > safeIndex ? 'forward' : 'back')}
              />
            )
          })}
        </div>
        {isLast ? (
          <button type="button" className="question-nav-button primary wide" onClick={onSubmit}>
            <Send size={14} />
            {t('questions.submit')}
          </button>
        ) : (
          <button type="button" className="question-nav-button primary" onClick={advance} aria-label={t('questions.next')}>
            <ArrowRight size={15} />
          </button>
        )}
      </footer>
    </section>
  )
}
