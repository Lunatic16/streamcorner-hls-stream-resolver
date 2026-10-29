import { getStreamDetail, listAllStreams, listProviderStreams } from '../resolve/stream.js'
import { resolveManifest } from '../resolve/manifest.js'

function escAttr(s) {
  return String(s || '').replace(/"/g, "'")
}

export async function generatePlaylist(origin, providerFilter = null, categoryFilter = null) {
  let streams = []
  if (providerFilter && providerFilter !== 'all') {
    streams = await listProviderStreams(providerFilter)
  } else {
    streams = await listAllStreams()
  }

  const lines = ['#EXTM3U']

  for (const s of streams) {
    if (categoryFilter && s.category && s.category.toLowerCase() !== categoryFilter.toLowerCase()) {
      continue
    }

    const provider = s.provider || 'channels'
    const rid = s.id
    if (!rid) continue

    const name = s.name || rid
    const logo = s.poster || ''
    const group = s.category || s.league || provider.toUpperCase()

    lines.push(
      `#EXTINF:-1 tvg-id="${escAttr(rid)}" tvg-name="${escAttr(name)}" tvg-logo="${escAttr(logo)}" group-title="${escAttr(group)}",${name}`,
    )
    lines.push(`${origin}/live/${provider}/${rid}.m3u8`)
  }

  return lines.join('\n') + '\n'
}

export async function resolveLiveChannel(provider, id) {
  const detail = await getStreamDetail(provider, id)
  if (!detail.embeds || detail.embeds.length === 0) {
    throw new Error(`No stream sources found for ${provider}/${id}`)
  }

  const firstSource = detail.embeds[0]
  const resolved = await resolveManifest(firstSource.url, 6000)

  if (resolved.manifestUrl) {
    return {
      streamUrl: resolved.manifestUrl,
      referer: firstSource.url,
      type: resolved.type,
    }
  }

  return {
    streamUrl: firstSource.url,
    referer: firstSource.url,
    type: 'embed',
  }
}
