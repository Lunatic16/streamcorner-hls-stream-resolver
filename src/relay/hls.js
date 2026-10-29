import { USER_AGENT } from '../env.js'
import { rewritePlaylist } from './rewrite.js'
import { segmentBody } from './segment.js'

const corsHeaders = {
  'Cache-Control': 'no-store, no-cache, must-revalidate',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
}

export function isPlaylist(url, contentType = '', body = Buffer.alloc(0)) {
  const head = body.toString('utf8', 0, Math.min(body.length, 512))
  if (head.includes('#EXTM3U')) return true
  const ct = String(contentType).toLowerCase()
  if (ct.includes('mpegurl') || ct.includes('m3u8')) return true
  try {
    const p = new URL(url).pathname.toLowerCase()
    return p.endsWith('.m3u8') || p.includes('.m3u8?')
  } catch {
    return false
  }
}

export async function relayHls(res, url, referer = '', origin = '') {
  const headers = {
    'User-Agent': USER_AGENT,
    Accept: '*/*',
  }

  if (referer) {
    try {
      const u = new URL(referer)
      headers.Referer = referer
      headers.Origin = u.origin
    } catch {}
  } else {
    try {
      const u = new URL(url)
      headers.Origin = u.origin
      headers.Referer = `${u.origin}/`
    } catch {}
  }

  const upstreamRes = await fetch(url, {
    headers,
    redirect: 'follow',
  })

  if (!upstreamRes.ok) {
    throw new Error(`Upstream returned HTTP ${upstreamRes.status} for ${url}`)
  }

  const contentType = upstreamRes.headers.get('content-type') || ''
  const arrayBuf = await upstreamRes.arrayBuffer()
  const rawBody = Buffer.from(arrayBuf)

  if (isPlaylist(url, contentType, rawBody)) {
    const rewritten = rewritePlaylist(rawBody.toString('utf8'), url, origin, referer)
    if (res.headersSent) return
    res.writeHead(200, {
      ...corsHeaders,
      'Content-Type': 'application/vnd.apple.mpegurl',
      'Content-Length': Buffer.byteLength(rewritten),
    })
    res.end(rewritten)
    return
  }

  // Segment or binary payload
  const body = segmentBody(rawBody)
  if (res.headersSent) return
  res.writeHead(200, {
    ...corsHeaders,
    'Content-Type': contentType || 'video/mp2t',
    'Content-Length': body.length,
  })
  res.end(body)
}
