import { SITE, PROVIDERS, BRANDED } from '../bridge/constants.js'
import { bridge } from '../bridge/worker.js'

const ID_ALIASES = [
  'stream_id',
  'content_id',
  'contentId',
  'serviceKey',
  'tile_id',
  'game_id',
  'channel_id',
  'id',
]

const URL_ALIASES = [
  'embed_url',
  'embedUrl',
  'stream_url',
  'manifest_url',
  'url',
  'href',
  'upsellUrl',
]

const COLLECTIONS = ['channels', 'items', 'events', 'live', 'vods']

export function firstPresent(rec, aliases, defaultVal = null) {
  if (!rec || typeof rec !== 'object') return defaultVal
  for (const a of aliases) {
    if (rec[a]) return rec[a]
    if (a === 'contentId' && rec.contentCANVideo && typeof rec.contentCANVideo === 'object') {
      if (rec.contentCANVideo.contentId) return rec.contentCANVideo.contentId
    }
  }
  if (rec.button && typeof rec.button === 'object' && rec.button.url) {
    return rec.button.url
  }
  return defaultVal
}

export function normalizeItem(rec, provider = null) {
  if (!rec || typeof rec !== 'object') return rec
  const rid = firstPresent(rec, ID_ALIASES)
  const out = {
    id: rid,
    provider: provider || rec.provider,
    name: rec.event_name || rec.title || rec.name || (rec.home_team && rec.away_team ? `${rec.away_team} @ ${rec.home_team}` : rid),
    category: rec.category || rec.league || (provider ? provider.toUpperCase() : 'OTHER'),
    league: rec.league,
    time: rec.time_et || rec.time || rec.time_label || rec.time_utc || 'LIVE',
    poster: rec.poster || rec.image || rec.category_logo || rec.home_team_logo,
  }

  for (const extra of [
    'home_team',
    'away_team',
    'home_score',
    'away_score',
    'chatroom',
    'description',
    'status',
    'timestamp',
  ]) {
    if (rec[extra] !== undefined && rec[extra] !== null && rec[extra] !== '') {
      out[extra] = rec[extra]
    }
  }

  if (provider && rid) {
    out.page_url = `${SITE}/stream/${provider}/${rid}`
    out.uri = `${provider}/${rid}`
  }

  const embed = firstPresent(rec, URL_ALIASES)
  if (embed) out.embed_url = embed

  return Object.fromEntries(Object.entries(out).filter(([_, v]) => v !== undefined && v !== null))
}

export function normalizeCollection(payload) {
  if (!payload) return []
  if (Array.isArray(payload)) return payload
  if (typeof payload === 'object') {
    for (const key of COLLECTIONS) {
      if (Array.isArray(payload[key])) return payload[key]
    }
    for (const key of COLLECTIONS) {
      const rails = payload[key]
      if (rails && typeof rails === 'object') {
        for (const k2 of COLLECTIONS) {
          if (Array.isArray(rails[k2])) return rails[k2]
        }
      }
    }
  }
  return [payload]
}

export function extractEmbeds(detail) {
  let recs = []
  if (Array.isArray(detail)) {
    recs = detail.filter((r) => r && typeof r === 'object')
  } else if (detail && typeof detail === 'object') {
    recs = [detail]
  }

  const out = []
  const seen = new Set()

  for (const rec of recs) {
    const pools = []
    for (const key of ['streams', 'sources', ...COLLECTIONS]) {
      const v = rec[key]
      if (Array.isArray(v)) {
        pools.push(...v.filter((x) => x && typeof x === 'object'))
      }
    }

    for (const s of pools) {
      const url = firstPresent(s, URL_ALIASES)
      if (url && !seen.has(url)) {
        seen.add(url)
        out.push({
          source: s.source_name || s.source || s.title || `STREAM ${out.length + 1}`,
          url,
        })
      }
    }

    const direct = firstPresent(rec, URL_ALIASES)
    if (direct && !seen.has(direct) && pools.length === 0) {
      seen.add(direct)
      out.push({
        source: rec.source_name || 'STREAM 1',
        url: direct,
      })
    }
  }

  return out
}

export async function listProviderStreams(provider) {
  const payload = await bridge.opList(provider)
  const items = normalizeCollection(payload)
  return items.map((i) => normalizeItem(i, provider))
}

export async function listAllStreams() {
  const activeProviders = Object.keys(PROVIDERS)
  const results = await Promise.allSettled(
    activeProviders.map(async (provider) => {
      try {
        return await listProviderStreams(provider)
      } catch (err) {
        console.warn(`[resolve] Failed to fetch provider ${provider}:`, err.message)
        return []
      }
    }),
  )

  const streams = []
  for (const res of results) {
    if (res.status === 'fulfilled' && Array.isArray(res.value)) {
      streams.push(...res.value)
    }
  }
  return streams
}

export async function getStreamDetail(provider, id) {
  const payload = await bridge.opDetail(provider, id)
  const rec = Array.isArray(payload) && payload.length > 0 ? payload[0] : payload
  const norm = normalizeItem(rec, provider)
  const embeds = extractEmbeds(payload)
  return {
    provider,
    id,
    record: norm,
    embeds,
  }
}

export function parseStreamUri(raw) {
  if (!raw) return { error: 'uri required' }
  let cleaned = String(raw).trim().replace(/^\/+/, '')
  if (cleaned.endsWith('.m3u8')) cleaned = cleaned.slice(0, -5)
  if (cleaned.startsWith('live/')) cleaned = cleaned.slice(5)
  if (cleaned.startsWith('stream/')) cleaned = cleaned.slice(7)

  const parts = cleaned.split('/')
  if (parts.length >= 2) {
    return { provider: parts[0], id: parts.slice(1).join('/') }
  }
  // Default provider fallback: channels or admin
  return { provider: 'channels', id: parts[0] }
}
