/**
 * Devtools panels (TanStack Router + React Query) must never render in a
 * production build. They mount heavy lazy/Suspense subtrees into the SSR
 * stream — when one can't finish streaming, React aborts the boundary and
 * the client logs the recoverable "server could not finish this Suspense
 * boundary" error (minified #419), then re-renders on the client. Because
 * the router devtools re-render on every navigation, that error recurs on
 * each state transition. Gating them out of prod removes the boundary.
 */
export function devtoolsEnabled(env: string | undefined = process.env.NODE_ENV): boolean {
  return env !== 'production'
}
