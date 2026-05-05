// Simple HTTP server for testing WASM in browser
// Run with: bun run __test__/serve.ts

const server = Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url)
    let filePath = url.pathname

    // Default to browser-test.html
    if (filePath === '/' || filePath === '') {
      filePath = '/__test__/browser-test.html'
    }

    // Remove leading slash and resolve relative to project root
    const fullPath = import.meta.dir + '/..' + filePath

    try {
      const file = Bun.file(fullPath)

      // Determine content type
      let contentType = 'text/plain'
      if (filePath.endsWith('.html')) {
        contentType = 'text/html'
      } else if (filePath.endsWith('.js') || filePath.endsWith('.mjs')) {
        contentType = 'application/javascript'
      } else if (filePath.endsWith('.wasm')) {
        contentType = 'application/wasm'
      } else if (filePath.endsWith('.json')) {
        contentType = 'application/json'
      }

      return new Response(file, {
        headers: {
          'Content-Type': contentType,
          // Required headers for SharedArrayBuffer (needed for WASM threads)
          'Cross-Origin-Opener-Policy': 'same-origin',
          'Cross-Origin-Embedder-Policy': 'require-corp',
          'Access-Control-Allow-Origin': '*',
        },
      })
    } catch (e) {
      return new Response('404 Not Found: ' + filePath, { status: 404 })
    }
  },
})

console.log(`Server running at http://localhost:${server.port}`)
console.log('Open browser to: http://localhost:3000')
