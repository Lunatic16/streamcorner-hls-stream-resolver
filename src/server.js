import http from 'node:http'
import { host, port } from './env.js'
import { onReq } from './http/route.js'
import { bridge } from './bridge/worker.js'

const srv = http.createServer(onReq)

function boot() {
  const addr = srv.address()
  const displayHost = typeof addr === 'string' ? addr : `localhost:${addr.port}`
  console.log(`\n========================================`)
  console.log(`📺 StreamCorner HLS Proxy & Resolver`)
  console.log(`📡 Server listening at: http://${displayHost}/`)
  console.log(`📻 Live Playlist at:   http://${displayHost}/playlist.m3u8`)
  console.log(`========================================\n`)

  // Pre-warm the worker bridge in background
  bridge.init().catch((err) => {
    console.warn('[server] Worker bridge background initialization warning:', err.message)
  })
}

srv.listen(port, host === '0.0.0.0' ? undefined : host, boot)

// Graceful shutdown
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.log(`\n[server] Received ${sig}, shutting down...`)
    await bridge.close()
    srv.close(() => {
      console.log('[server] Exited cleanly.')
      process.exit(0)
    })
  })
}
