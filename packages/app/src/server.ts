import handler, { createServerEntry } from '@tanstack/react-start/server-entry'

export default createServerEntry({
  async fetch(request) {
    const response = await handler.fetch(request)

    // Add COOP/COEP headers for SharedArrayBuffer (WASM threads)
    response.headers.set('Cross-Origin-Opener-Policy', 'same-origin')
    response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp')

    return response
  },
})
