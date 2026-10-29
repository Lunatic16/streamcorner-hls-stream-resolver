function abs(uri, base) {
  try {
    return uri.startsWith('http://') || uri.startsWith('https://')
      ? uri
      : new URL(uri, base).href
  } catch {
    return uri
  }
}

export function relayUrl(origin, targetUrl, referer = '') {
  const q = new URLSearchParams({ url: targetUrl })
  if (referer) q.set('referer', referer)
  return `${origin}/api/hls?${q.toString()}`
}

export function rewritePlaylist(text, base, origin, referer = '') {
  const lines = text.split('\n')
  const out = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()

    if (!trimmed) {
      out.push(line)
      continue
    }

    if (trimmed.startsWith('#')) {
      if (trimmed.startsWith('#EXT-X-KEY:')) {
        out.push(
          trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
            const href = abs(uri, base)
            return `URI="${relayUrl(origin, href, referer || base)}"`
          }),
        )
      } else if (trimmed.startsWith('#EXT-X-MAP:')) {
        out.push(
          trimmed.replace(/URI="([^"]+)"/, (_, uri) => {
            const href = abs(uri, base)
            return `URI="${relayUrl(origin, href, referer || base)}"`
          }),
        )
      } else {
        out.push(line)
      }
      continue
    }

    // This is a segment or sub-playlist URI line
    const href = abs(trimmed, base)
    out.push(relayUrl(origin, href, referer || base))
  }

  return out.join('\n')
}
