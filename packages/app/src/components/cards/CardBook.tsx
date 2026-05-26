import { useEffect, useState, type ReactNode } from 'react'

interface CardBookProps {
  front: ReactNode
  back: ReactNode
  /** Auto-open shortly after mount for the "passport is opening" feel. */
  autoOpenMs?: number
}

/**
 * 3D flip wrapper shared by every credential card type. Tap to toggle
 * between branded chrome (front) and the disclosed-claims panel (back).
 * Physics live in `styles.css` (`.card-book` / `.card-book.is-open`);
 * this component only owns the open/closed state.
 */
export function CardBook({ front, back, autoOpenMs = 400 }: CardBookProps) {
  const [isOpen, setIsOpen] = useState(false)

  useEffect(() => {
    if (autoOpenMs <= 0) return
    const t = setTimeout(() => setIsOpen(true), autoOpenMs)
    return () => clearTimeout(t)
  }, [autoOpenMs])

  return (
    <div className="card-book-container">
      <div
        className={`card-book ${isOpen ? 'is-open' : ''}`}
        onClick={() => setIsOpen((v) => !v)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setIsOpen((v) => !v)
          }
        }}
        aria-pressed={isOpen}
        aria-label={isOpen ? 'Close card' : 'Open card'}
      >
        <div className="card-book__face">{front}</div>
        <div className="card-book__face card-book__back">{back}</div>
      </div>
    </div>
  )
}
