import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

type Props = {
  label: string
  title: string
  lines: Array<string | null | undefined>
  tone?: 'falha' | 'neutro'
}

const CARD_WIDTH = 260

/** Botão que mostra a informação ao passar o mouse e fixa a janela ao clicar (para o celular). */
export function InfoPopover({ label, title, lines, tone = 'neutro' }: Props) {
  const [hover, setHover] = useState(false)
  const [pinned, setPinned] = useState(false)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)
  const btnRef = useRef<HTMLButtonElement>(null)
  const open = hover || pinned

  // Fica em position: fixed fora da tabela — senão a rolagem horizontal corta a janela
  useEffect(() => {
    if (!open) return
    const place = () => {
      const r = btnRef.current?.getBoundingClientRect()
      if (!r) return
      const left = Math.min(Math.max(8, r.left), Math.max(8, window.innerWidth - CARD_WIDTH - 8))
      setPos({ top: r.bottom + 6, left })
    }
    place()
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [open])

  useEffect(() => {
    if (!pinned) return
    const onDown = (e: MouseEvent | TouchEvent) => {
      if (!btnRef.current?.contains(e.target as Node)) setPinned(false)
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
    <>
      <button
        type="button"
        ref={btnRef}
        className={`btn-mini btn-ghost info-pop-btn ${tone === 'falha' ? 'info-pop-falha' : ''}`}
        aria-expanded={open}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => setPinned((v) => !v)}
      >
        {label}
      </button>
      {open && pos
        ? createPortal(
            <div
              className={`info-pop-card ${tone === 'falha' ? 'info-pop-card-falha' : ''}`}
              role="tooltip"
              style={{ top: pos.top, left: pos.left, width: CARD_WIDTH }}
            >
              <strong>{title}</strong>
              {visible.map((l, i) => (
                <span key={i}>{l}</span>
              ))}
            </div>,
            document.body,
          )
        : null}
    </>
  )
}
