(() => {
  if (globalThis.__verbooRoutineRecorderInstalled) return
  globalThis.__verbooRoutineRecorderInstalled = true

  let enabled = false

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'routine:recorder_enable') {
      enabled = true
    } else if (message?.type === 'routine:recorder_disable') {
      enabled = false
    }
  })

  for (const kind of ['click', 'input', 'change', 'submit']) {
    document.addEventListener(kind, (event) => {
      if (!enabled || !event.isTrusted) return
      const target = event.target instanceof Element ? event.target : null
      if (!target) return
      const payload = {
        kind,
        url: location.href,
        selectorCandidates: selectorCandidates(target),
        role: target.getAttribute('role') || undefined,
        accessibleName: accessibleName(target),
        text: visibleText(target),
        field: fieldMetadata(target),
        ...(kind === 'input' || kind === 'change'
          // FRENTE-B (B-1): a password value must never leave the page —
          // not even to the background. The field stays recorded (the step
          // is kept), but the value is suppressed at the source.
          ? { value: isPasswordField(target) ? '' : ('value' in target ? String(target.value ?? '') : '') }
          : {}),
        timestamp: Date.now(),
      }
      chrome.runtime.sendMessage({
        type: 'routine:record_event',
        event: payload,
      }).catch(() => {})
    }, true)
  }

  function selectorCandidates(element) {
    const selectors = []
    if (element.id) selectors.push(`#${CSS.escape(element.id)}`)
    const name = element.getAttribute('name')
    if (name) selectors.push(`${element.localName}[name="${cssString(name)}"]`)
    const testId = element.getAttribute('data-testid')
    if (testId) selectors.push(`[data-testid="${cssString(testId)}"]`)
    const ariaLabel = element.getAttribute('aria-label')
    if (ariaLabel) selectors.push(`[aria-label="${cssString(ariaLabel)}"]`)
    selectors.push(nthSelector(element))
    return [...new Set(selectors)].slice(0, 5)
  }

  function nthSelector(element) {
    const segments = []
    let current = element
    while (current && current.nodeType === Node.ELEMENT_NODE && segments.length < 5) {
      let segment = current.localName
      const parent = current.parentElement
      if (parent) {
        const siblings = [...parent.children].filter((child) => child.localName === current.localName)
        if (siblings.length > 1) segment += `:nth-of-type(${siblings.indexOf(current) + 1})`
      }
      segments.unshift(segment)
      current = parent
    }
    return segments.join(' > ')
  }

  function fieldMetadata(element) {
    const label = element.labels?.[0]?.innerText || element.getAttribute('aria-label') || ''
    return {
      type: element.getAttribute('type') || '',
      name: element.getAttribute('name') || '',
      id: element.id || '',
      autocomplete: element.getAttribute('autocomplete') || '',
      placeholder: element.getAttribute('placeholder') || '',
      ariaLabel: element.getAttribute('aria-label') || '',
      label: String(label).trim().slice(0, 180),
    }
  }

  // FRENTE-B (B-1): the value of a password field is never collected.
  // Both the explicit type=password and the autocomplete hint count.
  function isPasswordField(element) {
    const type = String(element.getAttribute('type') || '').toLowerCase()
    const autocomplete = String(element.getAttribute('autocomplete') || '').toLowerCase()
    return type === 'password'
      || autocomplete === 'current-password'
      || autocomplete === 'new-password'
  }

  function accessibleName(element) {
    return (
      element.getAttribute('aria-label') ||
      element.getAttribute('title') ||
      element.labels?.[0]?.innerText ||
      ''
    ).trim().slice(0, 180)
  }

  function visibleText(element) {
    return String(element.innerText || element.textContent || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180)
  }

  function cssString(value) {
    return String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  }
})()
