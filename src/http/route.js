import { PROVIDERS, BRANDED } from '../bridge/constants.js'
import { USER_AGENT } from '../env.js'
import { relayHls } from '../relay/hls.js'
import {
  getStreamDetail,
  listAllStreams,
  listProviderStreams,
  parseStreamUri,
} from '../resolve/stream.js'
import { resolveManifest } from '../resolve/manifest.js'
import { generatePlaylist, resolveLiveChannel } from '../playlist/iptv.js'
import { json, readBody, text } from './respond.js'
import { serveStatic } from './static.js'

export async function onReq(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': '*',
    })
    res.end()
    return
  }

  const hostHeader = req.headers.host || 'localhost:3000'
  const loc = new URL(req.url ?? '/', `http://${hostHeader}`)
  const { pathname, searchParams, origin } = loc

  try {
    // Relay HLS playlist and video segments
    if (pathname === '/api/hls') {
      const target = searchParams.get('url')
      if (!target) return json(res, 400, { error: 'url parameter required' })
      const referer = searchParams.get('referer') || ''
      try {
        await relayHls(res, target, referer, origin)
      } catch (err) {
        text(res, 502, `Upstream relay error: ${err.message}`)
      }
      return
    }

    // Embed proxy without CSP frame-ancestors restrictions
    if (pathname === '/embed-proxy') {
      const targetUrl = searchParams.get('url')
      if (!targetUrl) return text(res, 400, 'url required')
      try {
        const u = new URL(targetUrl)
        const upstream = await fetch(targetUrl, {
          headers: {
            'User-Agent': USER_AGENT,
            Referer: 'https://streamcorner.st/',
          },
        })
        let html = await upstream.text()
        // Strip anti-ad and anti-frame scripts
        html = html.replace(/<script[^>]+popa[^>]+><\/script>/gi, '')
        html = html.replace(/<script[^>]+cloudflareinsights[^>]*>.*?<\/script>/gi, '')
        html = html.replace('<head>', `<head><base href="${u.origin}/">`)
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        res.end(html)
      } catch (err) {
        text(res, 502, `Embed proxy error: ${err.message}`)
      }
      return
    }

    // List known providers
    if (pathname === '/api/providers') {
      const list = Object.entries(PROVIDERS).map(([p, c]) => ({
        provider: p,
        endpoint: c.endpoint,
        key_field: c.key,
      }))
      for (const [p, eps] of Object.entries(BRANDED)) {
        list.push({
          provider: p,
          endpoint: eps.join(', ') || '(detail-only)',
          key_field: 'contentId/stream_id',
        })
      }
      return json(res, 200, { ok: true, providers: list })
    }

    // Streams index
    if (pathname === '/api/streams' || pathname === '/api/events') {
      const providerParam = searchParams.get('provider') || 'all'
      try {
        let streams = []
        if (providerParam === 'all') {
          streams = await listAllStreams()
        } else {
          streams = await listProviderStreams(providerParam)
        }
        return json(res, 200, { ok: true, count: streams.length, streams })
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message })
      }
    }

    // Stream Detail (with embed sources)
    if (pathname === '/api/detail') {
      const provider = searchParams.get('provider')
      const id = searchParams.get('id')
      if (!provider || !id) {
        return json(res, 400, { error: 'provider and id parameters required' })
      }
      try {
        const detail = await getStreamDetail(provider, id)
        return json(res, 200, { ok: true, ...detail })
      } catch (err) {
        return json(res, 500, { ok: false, error: err.message })
      }
    }

    // Resolve an embed URL directly
    if (pathname === '/api/embed' || pathname === '/api/resolve') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' })
      const body = await readBody(req).catch(() => null)
      const iframeUrl = body?.iframe || body?.url
      if (!iframeUrl) return json(res, 400, { error: 'iframe or url required in body' })

      try {
        const resolved = await resolveManifest(iframeUrl, 5000)
        const streamUrl = resolved.manifestUrl || iframeUrl
        let proxiedUrl = ''

        if (resolved.type === 'm3u8' && resolved.manifestUrl) {
          proxiedUrl = `${origin}/api/hls?url=${encodeURIComponent(resolved.manifestUrl)}&referer=${encodeURIComponent(iframeUrl)}`
        } else if (resolved.manifestUrl) {
          proxiedUrl = resolved.manifestUrl
        } else {
          proxiedUrl = `${origin}/embed-proxy?url=${encodeURIComponent(iframeUrl)}`
        }

        return json(res, 200, {
          ok: true,
          type: resolved.type || 'm3u8',
          streamUrl,
          proxiedUrl,
          embedUrl: iframeUrl,
          clearKeys: resolved.clearKeys || null,
          direct: !!resolved.direct,
        })
      } catch (err) {
        return json(res, 500, { ok: false, stage: 'resolve', error: err.message })
      }
    }

    // Resolve stream by URI or provider+id
    if (pathname === '/api/stream') {
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' })
      const body = await readBody(req).catch(() => null)
      let provider = body?.provider
      let id = body?.id

      if (!provider || !id) {
        const parsed = parseStreamUri(body?.uri || body?.url)
        if (parsed.error) return json(res, 400, { error: parsed.error })
        provider = parsed.provider
        id = parsed.id
      }

      try {
        const detail = await getStreamDetail(provider, id)
        const sources = detail.embeds || []
        if (sources.length === 0) {
          return json(res, 404, { ok: false, error: 'No stream sources found for this item' })
        }

        const chosen = sources[0]
        const resolved = await resolveManifest(chosen.url, 5000)
        const streamUrl = resolved.manifestUrl || chosen.url
        const proxiedUrl = resolved.type === 'm3u8' && resolved.manifestUrl
          ? `${origin}/api/hls?url=${encodeURIComponent(resolved.manifestUrl)}&referer=${encodeURIComponent(chosen.url)}`
          : streamUrl

        return json(res, 200, {
          ok: true,
          provider,
          id,
          record: detail.record,
          sources,
          streamUrl,
          proxiedUrl,
          type: resolved.type || 'm3u8',
          clearKeys: resolved.clearKeys || null,
        })
      } catch (err) {
        return json(res, 500, { ok: false, stage: 'detail', error: err.message })
      }
    }

    // IPTV M3U playlist
    if (pathname === '/playlist.m3u8' || pathname === '/playlist') {
      try {
        const providerFilter = searchParams.get('provider') || undefined
        const categoryFilter = searchParams.get('category') || undefined
        const playlist = await generatePlaylist(origin, providerFilter, categoryFilter)

        if (res.headersSent) return
        res.writeHead(200, {
          'Content-Type': 'application/x-mpegurl; charset=utf-8',
          'Content-Disposition': 'inline; filename="playlist.m3u8"',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
        })
        res.end(playlist)
      } catch (err) {
        text(res, 502, `Playlist generation error: ${err.message}`)
      }
      return
    }

    // Per-channel live relay on-the-fly
    if (pathname.startsWith('/live/')) {
      let uri = pathname.slice(6)
      if (uri.endsWith('.m3u8')) uri = uri.slice(0, -5)
      uri = decodeURIComponent(uri)
      if (!uri) return text(res, 400, 'Channel uri required')

      const parsed = parseStreamUri(uri)
      if (parsed.error) return text(res, 400, parsed.error)

      try {
        const { streamUrl, referer } = await resolveLiveChannel(parsed.provider, parsed.id)
        await relayHls(res, streamUrl, referer, origin)
      } catch (err) {
        text(res, 502, `Live channel resolution error: ${err.message}`)
      }
      return
    }

    // Serve static files from /public
    if (serveStatic(pathname, res)) return

    text(res, 404, 'Not Found')
  } catch (err) {
    json(res, 500, { ok: false, error: String(err.message || err) })
  }
}
