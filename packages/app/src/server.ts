import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

export default createServerEntry({
  async fetch(request) {
    const response = await handler.fetch(request)

    // SharedArrayBuffer (WASM threads) needs cross-origin isolation
    // (COOP + COEP). `require-corp` would also reject any cross-origin
    // <img> whose host doesn't ship `Cross-Origin-Resource-Policy`
    // (Google profile pictures don't) → broken Google avatars. The
    // `credentialless` variant gives us the same isolation guarantees
    // for SharedArrayBuffer while loading cross-origin resources without
    // credentials when CORP is absent.
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless')

    return response
  },
})
