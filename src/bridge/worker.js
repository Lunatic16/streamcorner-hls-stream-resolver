import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { chromium } from 'playwright'
import { ensureWorkerChunks } from './bootstrap.js'
import { BRANDED, FAILOVER_POOL, MIRRORS, PROVIDERS } from './constants.js'
import { CACHE_DIR } from '../env.js'

class BridgeManager {
  constructor() {
    this.server = null
    this.port = null
    this.browser = null
    this.page = null
    this.isBooting = false
    this.bootPromise = null

    // Concurrency queue to serialize RPCs over the single page
    this.queue = Promise.resolve()

    // In-memory cache
    this.listCache = new Map() // key: provider, value: { data, expires }
    this.detailCache = new Map() // key: `${provider}:${id}`, value: { data, expires }
  }

  async init() {
    if (this.page && !this.page.isClosed() && this.browser?.isConnected()) {
      return
    }
    if (this.isBooting) return this.bootPromise

    this.isBooting = true
    this.bootPromise = (async () => {
      try {
        await ensureWorkerChunks()

        if (!this.server) {
          this.server = http.createServer((req, res) => {
            const reqPath = req.url === '/' ? 'harness.html' : req.url.replace(/^\/+/, '')
            const filePath = path.join(CACHE_DIR, reqPath)
            if (fs.existsSync(filePath)) {
              const ext = path.extname(filePath)
              const contentType = ext === '.html' ? 'text/html' : 'application/javascript'
              res.writeHead(200, {
                'Content-Type': contentType,
                'Access-Control-Allow-Origin': '*',
              })
              fs.createReadStream(filePath).pipe(res)
            } else {
              res.writeHead(404).end()
            }
          })
          await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve))
          this.port = this.server.address().port
          console.log(`[bridge] Local harness server running on 127.0.0.1:${this.port}`)
        }

        if (this.browser) {
          try {
            await this.browser.close()
          } catch {}
          this.browser = null
          this.page = null
        }

        console.log('[bridge] Launching headless Chromium...')
        this.browser = await chromium.launch({
          headless: true,
          args: [
            '--disable-blink-features=AutomationControlled',
            '--no-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
          ],
        })

        const context = await this.browser.newContext()
        this.page = await context.newPage()

        await this.page.goto(`http://127.0.0.1:${this.port}/harness.html`, {
          waitUntil: 'domcontentloaded',
          timeout: 30000,
        })
        await this.page.waitForFunction('window.__ready === true', { timeout: 20000 })
        const bootError = await this.page.evaluate(() => window.__bootError || '')
        if (bootError) throw new Error(`Worker bridge initialization failed: ${bootError}`)
        console.log('[bridge] Worker bridge successfully initialized and ready.')
      } finally {
        this.isBooting = false
      }
    })()

    return this.bootPromise
  }

  getMirrorCandidates(count = FAILOVER_POOL) {
    const shuffled = [...MIRRORS].sort(() => 0.5 - Math.random())
    return shuffled.slice(0, count).map((m) => `https://${m}`)
  }

  pageParam(endpoint) {
    try {
      const u = new URL(endpoint, 'https://dummy.local')
      return u.searchParams.get('p') || ''
    } catch {
      return ''
    }
  }

  async _executeRpc(operation, requestUrls, providerId, providerName, retries = 2) {
    let lastError = null
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.init()
        return await this.page.evaluate(
          (msg) => window.rpc(msg),
          { operation, requestUrls, providerId, providerName },
        )
      } catch (err) {
        lastError = err
        const errStr = String(err.message || err)

        // If the worker refused these mirrors with a timeout, try another subset
        if (errStr.includes('timeout') && attempt < retries) {
          requestUrls = this.getMirrorCandidates()
          continue
        }

        // Only restart browser if it actually crashed or disconnected
        const isDead = !this.browser?.isConnected() || this.page?.isClosed() || errStr.includes('Target page') || errStr.includes('closed')
        if (isDead) {
          try {
            if (this.browser) await this.browser.close()
          } catch {}
          this.browser = null
          this.page = null
        } else {
          // If it's just an application error (e.g. 403 from upstream mirror), don't kill browser
          throw err
        }
      }
    }
    throw new Error(`Worker RPC failed after retries: ${lastError?.message || lastError}`)
  }

  rpc(operation, requestUrls, providerId, providerName, retries = 2) {
    // Chain onto the queue to prevent overlapping RPCs from breaking page context
    const run = () => this._executeRpc(operation, requestUrls, providerId, providerName, retries)
    this.queue = this.queue.then(run, run)
    return this.queue
  }

  async opList(provider, { bypassCache = false } = {}) {
    const now = Date.now()
    if (!bypassCache && this.listCache.has(provider)) {
      const cached = this.listCache.get(provider)
      if (cached.expires > now) return cached.data
    }

    const cfg = PROVIDERS[provider]
    let base = ''
    if (cfg) {
      base = `/corner?p=${this.pageParam(cfg.endpoint)}`
    } else if (BRANDED[provider] && BRANDED[provider].length > 0) {
      base = `/corner?p=${this.pageParam(BRANDED[provider].at(-1))}`
    } else {
      base = `/corner?p=${provider}`
    }

    const urls = this.getMirrorCandidates().map((m) => `${m}${base}`)
    const data = await this.rpc('provider-list', urls, provider, provider.toUpperCase())

    // Cache list for 2 minutes
    this.listCache.set(provider, { data, expires: now + 120000 })
    return data
  }

  async opDetail(provider, itemId, { bypassCache = false } = {}) {
    const key = `${provider}:${itemId}`
    const now = Date.now()
    if (!bypassCache && this.detailCache.has(key)) {
      const cached = this.detailCache.get(key)
      if (cached.expires > now) return cached.data
    }

    const cfg = PROVIDERS[provider]
    const page = cfg ? this.pageParam(cfg.endpoint) : provider
    const qs = new URLSearchParams({ p: page, id: String(itemId) }).toString()
    const urls = this.getMirrorCandidates().map((m) => `${m}/corner?${qs}`)
    const data = await this.rpc('provider-detail', urls, provider, provider.toUpperCase())

    // Cache detail for 5 minutes
    this.detailCache.set(key, { data, expires: now + 300000 })
    return data
  }

  async close() {
    try {
      if (this.browser) await this.browser.close()
      if (this.server) this.server.close()
    } catch {}
    this.browser = null
    this.page = null
    this.server = null
  }
}

export const bridge = new BridgeManager()
