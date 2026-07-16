import type { Translator } from '../../i18n'

const CONTROLLED_SUMMARY_KEYS: Record<string, string> = {
  'Activate an unverified control in the approved app': 'computerUse.confirmation.summaries.unverifiedControl',
  'Save or overwrite content in the approved app': 'computerUse.confirmation.summaries.save',
  'Copy content from the approved app to the clipboard': 'computerUse.confirmation.summaries.copy',
  'Paste clipboard contents into the approved app': 'computerUse.confirmation.summaries.paste',
  'Cut content from the approved app to the clipboard': 'computerUse.confirmation.summaries.cut',
  'Delete content in the approved app': 'computerUse.confirmation.summaries.delete',
  'Type a key in the approved app': 'computerUse.confirmation.summaries.typeKey',
  'Replace selected content in the approved app': 'computerUse.confirmation.summaries.replaceSelection',
  'Type into a field that already contains content': 'computerUse.confirmation.summaries.overwriteField',
  'Type where the existing-content state could not be verified': 'computerUse.confirmation.summaries.unverifiedField',
}

export function friendlyConfirmationSummary(summary: string, t: Translator): string {
  const controlled = summary.trim()
  const exactKey = CONTROLLED_SUMMARY_KEYS[controlled]
  if (exactKey) return t(exactKey)
  if (/^Activate a consequential (?:button|checkbox|link|menu item|radio button|control) in the approved app$/.test(controlled)) {
    return t('computerUse.confirmation.summaries.consequentialControl')
  }
  if (/^Press \S+ to Activate a consequential .+ in the approved app$/.test(controlled)) {
    return t('computerUse.confirmation.summaries.keyboardConsequential')
  }
  if (/^Press \S+ on an unverified control in the approved app$/.test(controlled)) {
    return t('computerUse.confirmation.summaries.keyboardUnverified')
  }
  return t('computerUse.confirmation.summaries.generic')
}
