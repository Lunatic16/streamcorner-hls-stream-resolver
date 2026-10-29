const $ = (id) => document.getElementById(id)

const filter = $('filter')
const category = $('category')
const events = $('events')
const eventsContainer = $('events-container')
const out = $('out')
const placeholder = $('placeholder')
const sourceSection = $('source-section')
const sourceList = $('source-list')
const backBtn = $('back-btn')
const closeBtn = $('close-btn')
const extBtn = $('ext-btn')
const refreshBtn = $('refresh-btn')
const statusSeg = $('status-seg')
const title = $('title')
const vid = $('vid')
const frame = $('frame')
const err = $('err')
const playerStatus = $('player-status')
const playerStatusText = $('player-status-text')
const fields = {
  direct: $('direct'),
  proxy: $('proxy'),
  vlc: $('vlc'),
  mpv: $('mpv'),
  embed: $('embed'),
}

const REFRESH_MS = 5 * 60 * 1000
const RERENDER_MS = 60 * 1000

let hlsInstance = null
let shakaPlayer = null
let allEvents = []
let currentEvent = null
let currentSources = []
let currentUri = null
let currentSrcIdx = -1
let statusFilter = 'live' // live | upcoming | all
let playToken = 0

const HTML_ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => HTML_ESC[c])
}

/* ---------- Event state ---------- */

function getState(ev) {
  const t = String(ev.time || '').toUpperCase()
  if (t === 'LIVE' || t === '24/7' || ev.provider === 'channels') {
    return 'live'
  }
  if (t.includes('PM') || t.includes('AM') || t.includes(':')) {
    return 'soon'
  }
  return 'live'
}

function badgeFor(ev, state) {
  const is247 = ev.provider === 'channels'
  if (is247) return { cls: 'badge--live badge--247', text: '24/7' }
  if (state === 'live') return { cls: 'badge--live', text: 'LIVE' }
  if (state === 'soon') return { cls: 'badge--soon', text: 'SOON' }
  return { cls: '', text: 'INFO' }
}

function matchesStatus(state) {
  if (statusFilter === 'live') return state === 'live'
  if (statusFilter === 'upcoming') return state === 'soon'
  return true
}

/* ---------- Rendering ---------- */

function setCounts() {
  let live = 0
  let upcoming = 0
  for (const ev of allEvents) {
    const s = getState(ev)
    if (s === 'live') live++
    else if (s === 'soon') upcoming++
  }
  $('n-live').textContent = live
  $('n-upcoming').textContent = upcoming
  $('n-all').textContent = allEvents.length
}

function renderEvents() {
  const q = filter.value.trim().toLowerCase()
  const cat = category.value

  setCounts()

  const rows = []
  for (const ev of allEvents) {
    if (cat && ev.provider !== cat && ev.category !== cat) continue
    if (q && !ev.searchable.includes(q)) continue
    const state = getState(ev)
    if (!matchesStatus(state)) continue
    rows.push({ ev, state })
  }

  if (rows.length === 0) {
    const hint =
      statusFilter === 'live' && allEvents.length
        ? `<br><button type="button" class="btn" data-show-all>Show all streams</button>`
        : ''
    events.innerHTML = `<div class="browser__empty">No ${statusFilter === 'all' ? '' : statusFilter + ' '}streams match${hint}</div>`
    events.querySelector('[data-show-all]')?.addEventListener('click', () => setStatus('all'))
    return
  }

  const groupOf = ({ ev, state }) => {
    if (ev.provider === 'channels') return '24/7 Live Channels'
    if (state === 'live') return 'Live Now'
    if (state === 'soon') return 'Upcoming Events'
    return 'Other Streams'
  }

  let lastGroup = null
  const html = []
  for (const row of rows) {
    const g = groupOf(row)
    if (g !== lastGroup) {
      html.push(`<div class="group-label" role="presentation">${g}</div>`)
      lastGroup = g
    }
    const { ev, state } = row
    const badge = badgeFor(ev, state)
    const providerTag = ev.provider ? ev.provider.toUpperCase() : ''
    const categoryTag = ev.category && ev.category !== providerTag ? ev.category : ''

    html.push(`
      <button type="button" class="event${ev.uri === currentUri ? ' is-selected' : ''}" role="listitem" data-uri="${esc(ev.uri)}">
        <span class="badge ${badge.cls}">${badge.text || '&nbsp;'}</span>
        <span class="event__main">
          <span class="event__name" title="${esc(ev.name)}">${esc(ev.name)}</span>
          <span class="event__meta">
            <span>${esc(providerTag)}</span>
            ${categoryTag ? `<span class="event__dot">${esc(categoryTag)}</span>` : ''}
          </span>
        </span>
        <span class="event__side">
          <span>${esc(ev.time || 'LIVE')}</span>
          <span class="event__subs">Select</span>
        </span>
      </button>`)
  }
  events.innerHTML = html.join('')
}

events.addEventListener('click', (e) => {
  const item = e.target.closest('.event')
  if (item) showSources(item.dataset.uri)
})

function setStatus(next) {
  statusFilter = next
  statusSeg.querySelectorAll('.seg__btn').forEach((b) => {
    const on = b.dataset.status === next
    b.classList.toggle('is-active', on)
    b.setAttribute('aria-pressed', String(on))
  })
  renderEvents()
  events.scrollTop = 0
}

statusSeg.addEventListener('click', (e) => {
  const btn = e.target.closest('.seg__btn')
  if (btn) setStatus(btn.dataset.status)
})

/* ---------- Data Fetching ---------- */

async function loadEvents({ quiet = false } = {}) {
  if (!quiet) events.innerHTML = '<div class="browser__loading">Loading StreamCorner streams…</div>'
  refreshBtn.disabled = true
  refreshBtn.classList.add('is-spinning')

  try {
    const res = await fetch('/api/streams?provider=all')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (!data.ok || !Array.isArray(data.streams)) {
      throw new Error(data.error || 'Failed to parse stream listings')
    }

    const cats = new Set()
    allEvents = data.streams.map((raw) => {
      const name = raw.name || raw.id || 'Stream'
      const prov = raw.provider || 'channels'
      const cat = raw.category || prov.toUpperCase()
      cats.add(prov)
      if (raw.category) cats.add(raw.category)

      return {
        id: raw.id,
        name,
        provider: prov,
        category: cat,
        league: raw.league,
        time: raw.time || 'LIVE',
        poster: raw.poster,
        uri: raw.uri || `${prov}/${raw.id}`,
        embed_url: raw.embed_url,
        searchable: `${name} ${prov} ${cat} ${raw.league || ''}`.toLowerCase(),
      }
    })

    const selected = category.value
    const sortedCats = Array.from(cats).sort()
    category.innerHTML =
      '<option value="">All categories & providers</option>' +
      sortedCats.map((c) => `<option value="${esc(c)}">${esc(c)}</option>`).join('')
    if (sortedCats.includes(selected)) category.value = selected

    renderEvents()
  } catch (error) {
    if (quiet && allEvents.length) return
    events.innerHTML = `<div class="browser__error">Failed to load streams: ${esc(error.message)}<br><button type="button" class="btn" data-retry>Retry</button></div>`
    events.querySelector('[data-retry]')?.addEventListener('click', () => loadEvents())
  } finally {
    refreshBtn.disabled = false
    refreshBtn.classList.remove('is-spinning')
  }
}

/* ---------- Source picker & playback ---------- */

function showError(message) {
  err.textContent = message
  err.hidden = false
}

async function showSources(uri) {
  err.hidden = true

  const event = allEvents.find((ev) => ev.uri === uri)
  if (!event) {
    showError('Stream not found — try refreshing the list.')
    return
  }

  currentEvent = event
  currentUri = uri
  currentSrcIdx = -1

  sourceList.innerHTML = `<div class="browser__loading">Fetching available sources for ${esc(event.name)}…</div>`
  sourceSection.hidden = false
  eventsContainer.classList.add('browser--sources')

  try {
    const res = await fetch(`/api/detail?provider=${encodeURIComponent(event.provider)}&id=${encodeURIComponent(event.id)}`)
    const data = await res.json()
    if (!data.ok) throw new Error(data.error || 'Failed to load stream detail')

    currentSources = (data.embeds || []).map((s, idx) => ({
      label: s.source || `STREAM ${idx + 1}`,
      url: s.url,
      isDefault: idx === 0,
    }))

    if (currentSources.length === 0 && event.embed_url) {
      currentSources.push({
        label: 'STREAM 1',
        url: event.embed_url,
        isDefault: true,
      })
    }

    if (currentSources.length === 0) {
      sourceList.innerHTML = `<div class="browser__error">No playable embed sources found for this stream.<br><button type="button" class="btn" id="src-back">Back</button></div>`
      $('src-back')?.addEventListener('click', showList)
      return
    }

    if (currentSources.length === 1) {
      selectSource(0)
      return
    }

    sourceList.innerHTML = `
      <h3 class="source-section__title">${esc(event.name)}</h3>
      <p class="source-section__desc">Select a source to play (${currentSources.length} available):</p>
      <div class="source-list">
        ${currentSources
          .map(
            (src, idx) => `
          <button type="button" class="source-item${src.isDefault ? ' source-item--default' : ''}" data-idx="${idx}">
            <span class="source-item__label">${esc(src.label)}</span>
            ${src.isDefault ? '<span class="source-item__badge">default</span>' : ''}
          </button>`,
          )
          .join('')}
      </div>
    `
  } catch (error) {
    sourceList.innerHTML = `<div class="browser__error">Failed to fetch sources: ${esc(error.message)}<br><button type="button" class="btn" id="src-back">Back</button></div>`
    $('src-back')?.addEventListener('click', showList)
  }
}

sourceList.addEventListener('click', (e) => {
  const item = e.target.closest('.source-item')
  if (item) selectSource(parseInt(item.dataset.idx, 10))
})

function showList() {
  sourceSection.hidden = true
  eventsContainer.classList.remove('browser--sources')
  renderEvents()
}

function selectSource(idx) {
  const src = currentSources[idx]
  if (!src) return

  currentSrcIdx = idx
  sourceSection.hidden = true
  eventsContainer.classList.remove('browser--sources')
  out.hidden = false
  placeholder.classList.add('is-hidden')
  title.textContent = `${currentEvent.name} [${src.label}]`
  renderEvents()

  if (window.matchMedia('(max-width: 1099px)').matches) {
    out.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  resolveAndPlay(src.url, src.label)
}

function setPlayerStatus(text) {
  playerStatus.hidden = !text
  if (text) playerStatusText.textContent = text
}

async function resolveAndPlay(embedUrl, label) {
  const token = ++playToken
  err.hidden = true
  await stopPlayback()
  setPlayerStatus('Resolving stream manifest…')
  Object.values(fields).forEach((f) => (f.value = ''))

  try {
    const res = await fetch('/api/embed', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ iframe: embedUrl }),
    })
    const data = await res.json()
    if (token !== playToken) return
    if (!data.ok) throw new Error(`${data.stage || 'error'}: ${data.error || 'resolve failed'}`)

    const streamUrl = data.streamUrl || embedUrl
    const proxiedUrl = data.proxiedUrl || streamUrl

    fields.direct.value = streamUrl
    fields.proxy.value = proxiedUrl
    fields.vlc.value = vlc(proxiedUrl)
    fields.mpv.value = mpv(streamUrl, currentEvent?.name, data.clearKeys)
    fields.embed.value = embedUrl

    if (extBtn) {
      extBtn.hidden = false
      extBtn.href = embedUrl
    }

    if (data.type === 'mpd' && data.streamUrl) {
      setPlayerStatus('Starting DASH playback…')
      frame.hidden = true
      vid.hidden = false
      await playShaka(data.streamUrl, data.clearKeys, token)
      if (token === playToken) setPlayerStatus('')
    } else if (data.type === 'm3u8' && (data.proxiedUrl || data.streamUrl)) {
      setPlayerStatus('Starting HLS playback…')
      frame.hidden = true
      vid.hidden = false
      await playHls(data.proxiedUrl || data.streamUrl, token)
      if (token === playToken) setPlayerStatus('')
    } else {
      // Fallback: Embed proxy iframe playback
      setPlayerStatus('')
      vid.hidden = true
      frame.hidden = false
      frame.src = `/embed-proxy?url=${encodeURIComponent(embedUrl)}`
    }
  } catch (error) {
    if (token !== playToken) return
    setPlayerStatus('')
    showError(`Stream resolution notice: ${error.message}. Switching to embed player...`)
    vid.hidden = true
    frame.hidden = false
    frame.src = `/embed-proxy?url=${encodeURIComponent(embedUrl)}`
  }
}

function vlc(url) {
  return `vlc "${url}"`
}

function mpv(url, name, clearKeys) {
  let keyArg = ''
  if (clearKeys && typeof clearKeys === 'object') {
    const firstKey = Object.values(clearKeys)[0]
    if (firstKey) keyArg = ` --demuxer-lavf-o=decryption_key=${firstKey}`
  }
  if (!name) return `mpv${keyArg} "${url}"`
  return `mpv${keyArg} --force-media-title="${String(name).replace(/"/g, '\\"')}" "${url}"`
}

async function stopPlayback() {
  if (shakaPlayer) {
    try {
      await shakaPlayer.destroy()
    } catch {}
    shakaPlayer = null
  }
  if (hlsInstance) {
    try {
      hlsInstance.destroy()
    } catch {}
    hlsInstance = null
  }
  vid.pause()
  vid.removeAttribute('src')
  vid.load()
  frame.removeAttribute('src')
  frame.hidden = true
  vid.hidden = false
}

async function playShaka(manifestUrl, clearKeys, token) {
  if (window.shaka) {
    window.shaka.polyfill.installAll()
  } else {
    throw new Error('Shaka Player library is not loaded')
  }

  if (!window.shaka.Player.isBrowserSupported()) {
    throw new Error('Shaka DASH playback is not supported in this browser.')
  }

  const player = new window.shaka.Player()
  shakaPlayer = player
  await player.attach(vid)

  if (clearKeys && typeof clearKeys === 'object' && Object.keys(clearKeys).length > 0) {
    player.configure({
      drm: {
        clearKeys,
      },
    })
  }

  player.configure({
    streaming: {
      bufferingGoal: 10,
      rebufferingGoal: 2,
    },
  })

  await player.load(manifestUrl)
  if (token !== playToken) return
  await vid.play().catch(() => {})
}

async function playHls(url, token) {
  const HlsClass = window.Hls || (await import('https://cdn.jsdelivr.net/npm/hls.js@1.5.20/+esm')).default

  if (HlsClass && HlsClass.isSupported()) {
    const hls = new HlsClass({
      enableWorker: true,
      lowLatencyMode: true,
      backBufferLength: 60,
    })
    hlsInstance = hls
    hls.loadSource(url)
    hls.attachMedia(vid)

    await new Promise((resolve, reject) => {
      hls.on(HlsClass.Events.MANIFEST_PARSED, resolve)
      hls.on(HlsClass.Events.ERROR, (_, data) => {
        if (data.fatal) reject(new Error('HLS playback fatal error'))
      })
    })

    if (token !== playToken) return
    await vid.play().catch(() => {})
  } else if (vid.canPlayType('application/vnd.apple.mpegurl')) {
    vid.src = url
    await vid.play().catch(() => {})
  } else {
    throw new Error('HLS is not supported natively in this browser. Use VLC or MPV.')
  }
}

/* ---------- Clipboard ---------- */

async function copyToClipboard(text, node = null) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {}
  }

  let tmp = null
  if (!node) {
    tmp = document.createElement('textarea')
    tmp.value = text
    tmp.setAttribute('readonly', '')
    tmp.style.cssText = 'position:fixed;top:0;left:-9999px;opacity:0;'
    document.body.appendChild(tmp)
    node = tmp
  }
  node.focus()
  node.select()
  if (node.setSelectionRange) node.setSelectionRange(0, text.length)
  let ok = false
  try {
    ok = document.execCommand('copy')
  } catch {
    ok = false
  }
  if (tmp) tmp.remove()
  return ok
}

function flash(btn, text, cls, ms) {
  const label = btn.dataset.label ?? btn.textContent
  btn.dataset.label = label
  btn.textContent = text
  btn.classList.add(cls)
  setTimeout(() => {
    btn.textContent = label
    btn.classList.remove(cls)
    delete btn.dataset.label
  }, ms)
}

document.querySelectorAll('[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const node = $(btn.dataset.copy)
    if (!node.value) return
    const copied = await copyToClipboard(node.value, node)
    if (copied) flash(btn, 'Copied', 'ok', 1200)
    else flash(btn, 'Failed', 'err', 1500)
  })
})

/* ---------- Wiring ---------- */

backBtn.addEventListener('click', showList)

closeBtn.addEventListener('click', async () => {
  playToken++
  await stopPlayback()
  setPlayerStatus('')
  out.hidden = true
  placeholder.classList.remove('is-hidden')
  currentUri = null
  err.hidden = true
  if (extBtn) extBtn.hidden = true
  renderEvents()
})

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !sourceSection.hidden) showList()
})

refreshBtn.addEventListener('click', () => loadEvents({ quiet: true }))
filter.addEventListener('input', renderEvents)
category.addEventListener('change', renderEvents)

const copyPlaylistBtn = $('copy-playlist-btn')
const copyPlaylistLabel = copyPlaylistBtn.querySelector('.btn__label')
copyPlaylistBtn.addEventListener('click', async () => {
  const url = `${location.origin}/playlist.m3u8`
  const copied = await copyToClipboard(url)
  if (copied) {
    copyPlaylistLabel.textContent = 'Copied!'
    copyPlaylistBtn.classList.add('btn--copied')
    setTimeout(() => {
      copyPlaylistLabel.textContent = 'Copy URL'
      copyPlaylistBtn.classList.remove('btn--copied')
    }, 1500)
  } else {
    prompt('Copy this playlist URL:', url)
  }
})

setInterval(() => {
  if (!document.hidden) renderEvents()
}, RERENDER_MS)

setInterval(() => {
  if (!document.hidden) loadEvents({ quiet: true })
}, REFRESH_MS)

loadEvents()
