import { useEffect, useState } from 'react'
import Owl from '~/components/Owl'

interface LoadingScreenProps {
  /** Optional caption under the wordmark — defaults to a 3-dot breath
   *  when omitted. */
  caption?: string
  /** Fullscreen overlay vs. inline (e.g. embedded in a modal). */
  variant?: 'fullscreen' | 'inline'
}

/**
 * The OwlID app's loading screen — the animated owl mark + wordmark,
 * floating gently over a radial glow so the wait reads as deliberate
 * brand rather than dead air. Used by the TanStack Router pending
 * component and the SSR hydration fallback.
 *
 * Animations are CSS-only on purpose: any JS-managed initial value
 * (e.g. opacity:0) bakes into the SSR HTML and leaves a blank frame
 * until hydration. CSS keyframes (`float`, `blink`, `loader-glow`,
 * `loader-dot`) run from the very first paint.
 */
export function LoadingScreen({ caption, variant = 'fullscreen' }: LoadingScreenProps) {
  return (
    <div
      className={
        variant === 'fullscreen'
          ? // z-[60] sits above the sticky AppHeader (z-40) and the modal portal (z-50),
            // so it covers the full app chrome — no header strip showing through.
            'fixed inset-0 z-[60] flex flex-col items-center justify-center bg-background text-foreground'
          : 'flex flex-col items-center justify-center py-16'
      }
      role="status"
      aria-live="polite"
      aria-busy="true"
    >
      <div className="relative flex items-center justify-center">
        {/* Pulsing radial glow underneath the owl. CSS-only so it
            paints from SSR onward without waiting for JS. */}
        <span
          aria-hidden
          className="absolute w-56 h-56 rounded-full pointer-events-none"
          style={{
            background:
              'radial-gradient(closest-side, rgba(255,255,255,0.10), rgba(255,255,255,0))',
            filter: 'blur(8px)',
            animation: 'loader-glow 3.2s ease-in-out infinite',
          }}
        />

        {/* Owl wrapper gets the gentle vertical float; `blink` runs
            inside the Owl component already. */}
        <div className="relative" style={{ animation: 'float 4.5s ease-in-out infinite' }}>
          <Owl size={150} />
        </div>
      </div>

      <div className="mt-10 flex flex-col items-center gap-2 text-center">
        <p className="text-base font-semibold tracking-[0.32em] text-white/90">OWL ID</p>
        {caption ? <p className="text-sm text-muted-foreground">{caption}</p> : <LoadingDots />}
      </div>
    </div>
  )
}

/** Three-dot breathing indicator. Pure CSS — keyframes in styles.css. */
function LoadingDots() {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="block w-1.5 h-1.5 rounded-full bg-white/60"
          style={{
            animation: 'loader-dot 1.2s ease-in-out infinite',
            animationDelay: `${i * 0.15}s`,
          }}
        />
      ))}
    </div>
  )
}

/**
 * Wraps the document body so the {@link LoadingScreen} renders during
 * SSR + the first client paint, then unmounts once React has
 * hydrated. Without this, users see "header + blank body" between the
 * initial HTML response and the route's `defaultPendingComponent`
 * mounting.
 *
 * The loader DOM is part of both the SSR tree and the initial client
 * tree (so React hydration matches); the `useEffect` then flips the
 * state on the next animation frame and the loader unmounts. Anything
 * the loader was covering (header, route content) is unchanged
 * underneath, so the transition is a single fade.
 */
export function HydrationGate({ children }: { children: React.ReactNode }) {
  const [hydrated, setHydrated] = useState(false)
  useEffect(() => {
    // Wait one paint so the route's pending component has a chance
    // to take over without a flash of un-styled content.
    const id = requestAnimationFrame(() => setHydrated(true))
    return () => cancelAnimationFrame(id)
  }, [])
  return (
    <>
      {children}
      {hydrated ? null : <LoadingScreen />}
    </>
  )
}

export default LoadingScreen
