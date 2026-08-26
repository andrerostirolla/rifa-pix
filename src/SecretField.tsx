import { useState } from 'react'

function EyeIcon({ off }: { off?: boolean }) {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M2 12s3.6-6.5 10-6.5S22 12 22 12s-3.6 6.5-10 6.5S2 12 2 12Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <circle cx="12" cy="12" r="3" stroke="currentColor" strokeWidth="1.7" />
      {off ? <path d="M4 20 20 4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /> : null}
    </svg>
  )
}

type Props = {
  label: string
  hint?: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
  numeric?: boolean
}

/** Senha/PIN sempre escondido, com botão de olho para revelar quando precisar. */
export function SecretField({ label, hint, value, onChange, autoFocus, numeric }: Props) {
  const [shown, setShown] = useState(false)
  return (
    <label className="full">
      {label}
      <span className="secret-field">
        <input
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          autoComplete="off"
          inputMode={numeric && shown ? 'numeric' : undefined}
        />
        <button
          type="button"
          className="secret-toggle"
          onClick={() => setShown((v) => !v)}
          aria-label={shown ? `Esconder ${label}` : `Mostrar ${label}`}
          title={shown ? 'Esconder' : 'Mostrar'}
        >
          <EyeIcon off={shown} />
        </button>
      </span>
      {hint ? <span className="hint">{hint}</span> : null}
    </label>
  )
}
