import { useEffect, useRef, useState } from 'react'

type Props = {
  label: string
  title: string
  lines: Array<string | null | undefined>
  tone?: 'falha' | 'neutro'
}

/** Botão que mostra a informação ao passar o mouse e fixa a janela ao clicar (para o celular). */
export function InfoPopover({ label, title, lines, tone = 'neutro' }: Props) {
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const wrapRef = useRef<HTMLSpanElement>(null)
  const open = hover || pinned

  useEffect(() => {
    if (!pinned) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setPinned(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setPinned(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('touchstart', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('touchstart', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [pinned])

  const visible = lines.filter((l): l is string => Boolean(l && l.trim()))

  return (
    <span
      className="info-pop"
      ref={wrapRef}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
    >
      <button
        type="button"
        className={`btn-mini btn-ghost info-pop-btn ${tone === 'falha' ? 'info-pop-falha' : ''}`}
        aria-expanded={open}
        onClick={() => setPinned((v) => !v)}
      >
        {label}
      </button>
      {open && (
        <span className="info-pop-card" role="tooltip">
          <strong>{title}</strong>
          {visible.map((l, i) => (
            <span key={i}>{l}</span>
          ))}
        </span>
      )}
    </span>
  )
}
