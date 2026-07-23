import mascotUrl from '../../../../assets/branding/verboo-mascot.png'

type VerbooPetRigProps = {
  label: string
}

/**
 * The production mascot silhouette stays sourced from the brand asset. A
 * same-colour face plate gives the eyes and mouth independent animation
 * controls without redrawing or approximating the character outline.
 */
export function VerbooPetRig({ label }: VerbooPetRigProps) {
  return (
    <svg
      className="pet-rig"
      viewBox="0 0 200 200"
      role="img"
      aria-label={label}
    >
      <g className="pet-rig-body" data-pet-cue="idle">
        <image className="pet-rig-silhouette" href={mascotUrl} width="200" height="200" />
        <ellipse className="pet-rig-face-plate" cx="96" cy="99" rx="54" ry="43" />

        <g className="pet-rig-eyes">
          <ellipse className="pet-eye pet-eye-left" cx="67.5" cy="88.5" rx="8.5" ry="13" />
          <ellipse className="pet-eye pet-eye-right" cx="121.5" cy="88.5" rx="8.5" ry="13" />
        </g>

        <g className="pet-rig-mouth">
          <path className="pet-mouth pet-mouth-smile" d="M78 111 Q95 128 113 111" />
          <path className="pet-mouth pet-mouth-error" d="M79 122 Q95 106 112 122" />
        </g>
      </g>

      <g className="pet-prop pet-prop-think" data-pet-cue="thinking" aria-hidden="true">
        <circle className="pet-thought pet-thought-1" cx="143" cy="47" r="4" />
        <circle className="pet-thought pet-thought-2" cx="154" cy="35" r="6" />
        <path className="pet-thought pet-thought-cloud" d="M167 9c-11 0-19 7-19 16 0 7 5 12 12 15 4 2 8 7 8 12 5-5 8-9 15-10 10-1 17-7 17-16 0-10-9-17-20-17-4 0-8 1-13 4-3-3-6-4-10-4Z" />
        <path className="pet-thought-mark" d="M171 20c1-5 11-5 12 0 1 4-4 5-6 8v3M177 36h.1" />
      </g>

      <g className="pet-prop pet-prop-read" data-pet-cue="reading" aria-hidden="true">
        <g className="pet-read-paper">
          <rect x="-18" y="65" width="58" height="78" rx="8" />
          <path d="M-5 83h31M-5 96h31M-5 109h31M-5 122h23" />
          <rect className="pet-read-focus" x="-7" y="78" width="36" height="9" rx="4.5" />
        </g>
      </g>

      <g className="pet-prop pet-prop-edit" data-pet-cue="editing" aria-hidden="true">
        <g className="pet-edit-paper">
          <rect x="132" y="112" width="66" height="64" rx="8" />
          <path className="pet-ink pet-ink-1" d="M143 132c10-7 19 8 29 0" />
          <path className="pet-ink pet-ink-2" d="M143 146c12-7 25 7 39-1" />
          <path className="pet-ink pet-ink-3" d="M143 160c9-6 17 5 27 0" />
        </g>
        <g className="pet-edit-pencil">
          <rect x="176" y="87" width="8" height="48" rx="4" />
          <path d="M176 135h8l-4 10Z" />
        </g>
      </g>

      <g className="pet-prop pet-prop-delete" data-pet-cue="deleting" aria-hidden="true">
        <g className="pet-delete-paper">
          <rect x="119" y="91" width="25" height="31" rx="4" />
          <path d="M125 100h13M125 107h10" />
        </g>
        <g className="pet-delete-bin">
          <path d="M154 139h38l-4 42h-30Z" />
          <path className="pet-delete-lid" d="M151 134h44M164 128h18" />
        </g>
      </g>

      <g className="pet-prop pet-prop-command" data-pet-cue="command" aria-hidden="true">
        <g className="pet-command-screen">
          <rect x="145" y="49" width="62" height="72" rx="9" />
          <path className="pet-command-glyph pet-command-glyph-1" d="M156 68l7 6-7 6M169 80h14" />
          <path className="pet-command-glyph pet-command-glyph-2" d="M156 92h31" />
          <path className="pet-command-glyph pet-command-glyph-3" d="M156 104h22" />
        </g>
        <g className="pet-command-keyboard">
          <rect x="39" y="157" width="122" height="31" rx="8" />
          <path d="M52 169h13M72 169h13M92 169h13M112 169h13M132 169h16" />
          <rect className="pet-command-key pet-command-key-1" x="51" y="165" width="17" height="9" rx="3" />
          <rect className="pet-command-key pet-command-key-2" x="92" y="165" width="17" height="9" rx="3" />
          <rect className="pet-command-key pet-command-key-3" x="131" y="165" width="19" height="9" rx="3" />
        </g>
      </g>

      <g className="pet-prop pet-prop-done" data-pet-cue="success" aria-hidden="true">
        <circle cx="166" cy="44" r="23" />
        <path d="m154 44 8 8 16-18" />
      </g>

      <g className="pet-prop pet-prop-error" data-pet-cue="error" aria-hidden="true">
        <path d="m165 19 28 49h-56Z" />
        <path className="pet-error-mark" d="M165 35v16M165 59h.1" />
      </g>
    </svg>
  )
}
