import { chromium } from 'playwright'
import { USER_AGENT } from '../env.js'

let resolverBrowser = null

async function getResolverBrowser() {
  if (resolverBrowser && resolverBrowser.isConnected()) {
    return resolverBrowser
  }
  try {
    if (resolverBrowser) await resolverBrowser.close()
  } catch {}

  resolverBrowser = await chromium.launch({
    headless: true,
    args: [
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--autoplay-policy=no-user-gesture-required',
    ],
  })
  return resolverBrowser
}

export async function resolveManifest(embedUrl, settleMs = 5000) {
  if (!embedUrl) throw new Error('embedUrl required')

  // Direct manifest URL
  if (embedUrl.includes('.m3u8')) {
    return { manifestUrl: embedUrl, type: 'm3u8', direct: true, clearKeys: null }
  }
  if (embedUrl.includes('.mpd')) {
    return { manifestUrl: embedUrl, type: 'mpd', direct: true, clearKeys: null }
  }

  let browser = null
  let page = null
  let result = null

  try {
    browser = await getResolverBrowser()
    const context = await browser.newContext({
      userAgent: USER_AGENT,
      viewport: { width: 1280, height: 720 },
      bypassCSP: true,
    })
    page = await context.newPage()

    // Add trap hooks before any page scripts load
    await page.addInitScript(() => {
      function onCapturedSource(source) {
        if (!source || window.__capturedSource) return
        let clearKeys = {}
        if (source.drm?.clearkey && Array.isArray(source.drm.clearkey)) {
          for (const item of source.drm.clearkey) {
            if (item.kid && item.key) clearKeys[item.kid] = item.key
          }
        }
        window.__capturedSource = {
          dash: source.dash || null,
          hls: source.hls || null,
          clearKeys: Object.keys(clearKeys).length ? clearKeys : null,
        }
      }

      // 1. Bitmovin trap
      let origBitmovin = undefined
      Object.defineProperty(window, 'bitmovin', {
        configurable: true,
        enumerable: true,
        get() { return origBitmovin },
        set(val) {
          origBitmovin = val
          try {
            if (val?.player?.Player) {
              const OrigPlayer = val.player.Player
              val.player.Player = function (c, cfg) {
                const p = new OrigPlayer(c, cfg)
                const origLoad = p.load.bind(p)
                p.load = function (s) {
                  onCapturedSource(s)
                  return origLoad(s)
                }
                return p
              }
            }
          } catch {}
        },
      })

      // 2. Shaka Player trap
      let origShaka = undefined
      Object.defineProperty(window, 'shaka', {
        configurable: true,
        enumerable: true,
        get() { return origShaka },
        set(val) {
          origShaka = val
          try {
            if (val?.Player) {
              const OrigShaka = val.Player
              val.Player = function (el) {
                const p = new OrigShaka(el)
                const origLoad = p.load.bind(p)
                p.load = function (uri) {
                  if (typeof uri === 'string') {
                    window.__capturedSource = {
                      dash: uri.includes('.mpd') ? uri : null,
                      hls: uri.includes('.m3u8') ? uri : null,
                      clearKeys: null,
                    }
                  }
                  return origLoad(uri)
                }
                return p
              }
            }
          } catch {}
        },
      })

      // 3. JWPlayer trap
      let origJwplayer = undefined
      Object.defineProperty(window, 'jwplayer', {
        configurable: true,
        enumerable: true,
        get() { return origJwplayer },
        set(val) {
          origJwplayer = function (...args) {
            const inst = val(...args)
            if (inst && inst.setup) {
              const origSetup = inst.setup.bind(inst)
              inst.setup = function (cfg) {
                if (cfg?.file) {
                  const f = cfg.file
                  window.__capturedSource = {
                    dash: f.includes('.mpd') ? f : null,
                    hls: f.includes('.m3u8') ? f : null,
                    clearKeys: null,
                  }
                }
                return origSetup(cfg)
              }
            }
            return inst
          }
        },
      })
    })

    // Network request listener fallback
    page.on('response', (res) => {
      const u = res.url()
      const ct = (res.headers()['content-type'] || '').toLowerCase()
      if (u.includes('.m3u8') || ct.includes('mpegurl') || ct.includes('application/x-mpegurl')) {
        if (!result) result = { manifestUrl: u, type: 'm3u8', clearKeys: null }
      } else if (u.includes('.mpd') || ct.includes('dash+xml')) {
        if (!result) result = { manifestUrl: u, type: 'mpd', clearKeys: null }
      }
    })

    await page.goto(embedUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 15000,
    }).catch(() => {})

    // Check for trapped source config
    const start = Date.now()
    while (Date.now() - start < settleMs) {
      const captured = await page.evaluate(() => window.__capturedSource).catch(() => null)
      if (captured && (captured.dash || captured.hls)) {
        result = {
          manifestUrl: captured.dash || captured.hls,
          type: captured.dash ? 'mpd' : 'm3u8',
          clearKeys: captured.clearKeys || null,
        }
        break
      }
      if (result) break
      await new Promise((r) => setTimeout(r, 200))
    }
  } catch (err) {
    console.warn(`[manifest] Resolve error for ${embedUrl}:`, err.message)
  } finally {
    if (page) {
      try {
        await page.context().close()
      } catch {}
    }
  }

  if (result) return result

  return {
    manifestUrl: null,
    embedUrl,
    type: 'embed',
    clearKeys: null,
  }
}
