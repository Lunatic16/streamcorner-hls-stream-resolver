import fs from 'node:fs'
import path from 'node:path'
import { ASSETS, SITE, createHarnessHtml } from './constants.js'
import { CACHE_DIR, USER_AGENT } from '../env.js'

const ASSET_NAME = /^[A-Za-z0-9_-]+\.js$/
const MAX_ASSET_BYTES = 600_000
const MAX_GRAPH_ASSETS = 20
const MAX_GRAPH_BYTES = 4_000_000
const MAX_DISCOVERY_ASSETS = 24

function assetReferences(text) {
  return [...text.matchAll(/["'](?:\.\/)?([A-Za-z0-9_-]+\.js)["']/g)].map((match) => match[1])
}

function isCatalogModule(text) {
  const exports = /export\{([^}]+)\}/.exec(text)?.[1] || ''
  return /data\.[a-z0-9-]+\.workers\.dev/.test(text) &&
    /\bas\s+u(?:\s*[,}]|$)/.test(exports) &&
    /\bas\s+e(?:\s*[,}]|$)/.test(exports)
}

async function fetchText(url, label, maxBytes = MAX_ASSET_BYTES) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': USER_AGENT,
      Accept: '*/*',
      Referer: `${SITE}/`,
    },
    redirect: 'error',
    signal: AbortSignal.timeout(10000),
  })
  if (!res.ok) throw new Error(`Failed to fetch ${label}: HTTP ${res.status}`)
  const declaredLength = Number(res.headers.get('content-length') || 0)
  if (declaredLength > maxBytes) throw new Error(`Failed to fetch ${label}: response too large`)
  const text = await res.text()
  if (text.length > maxBytes) throw new Error(`Failed to fetch ${label}: response too large`)
  return text
}

async function fetchAsset(name) {
  if (!ASSET_NAME.test(name)) throw new Error(`Invalid StreamCorner asset name: ${name}`)
  const text = await fetchText(`${ASSETS}${name}`, `StreamCorner asset ${name}`)
  const prefix = text.trimStart().toLowerCase()
  if (prefix.startsWith('<!doctype html') || prefix.startsWith('<html')) {
    throw new Error(`Failed to fetch StreamCorner asset ${name}: upstream returned HTML`)
  }
  return text
}

export async function discoverCatalogModule() {
  const html = await fetchText(`${SITE}/`, 'StreamCorner home page', 1_000_000)
  const initial = [...html.matchAll(/(?:src|href)=["'](?:https:\/\/streamcorner\.st)?\/assets\/([A-Za-z0-9_-]+\.js)["']/gi)]
    .map((match) => match[1])
  if (initial.length === 0) throw new Error('Current StreamCorner entry asset not found')

  const queue = [...new Set(initial)]
  const inspected = new Map()
  while (queue.length && inspected.size < MAX_DISCOVERY_ASSETS) {
    const name = queue.shift()
    if (inspected.has(name)) continue
    const text = await fetchAsset(name)
    inspected.set(name, text)
    if (isCatalogModule(text)) return { name, inspected }
    for (const dependency of assetReferences(text)) {
      if (!inspected.has(dependency) && !queue.includes(dependency)) queue.push(dependency)
    }
  }
  throw new Error('Current StreamCorner catalog module not found')
}

export async function ensureWorkerChunks(forceRefresh = false) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }

  const { name: catalogModule, inspected } = await discoverCatalogModule()
  console.log(`[bootstrap] Discovered catalog module ${catalogModule}`)

  const queue = [catalogModule]
  const graph = new Map()
  let totalBytes = 0
  while (queue.length) {
    const name = queue.shift()
    if (graph.has(name)) continue
    if (!ASSET_NAME.test(name) || graph.size >= MAX_GRAPH_ASSETS) {
      throw new Error('StreamCorner module graph is too large')
    }
    const chunkPath = path.join(CACHE_DIR, name)
    let text
    if (!forceRefresh && fs.existsSync(chunkPath)) text = fs.readFileSync(chunkPath, 'utf8')
    else text = inspected.get(name) || await fetchAsset(name)
    totalBytes += Buffer.byteLength(text)
    if (totalBytes > MAX_GRAPH_BYTES) throw new Error('StreamCorner module graph is too large')
    graph.set(name, text)
    for (const dependency of assetReferences(text)) {
      if (!graph.has(dependency) && !queue.includes(dependency)) queue.push(dependency)
    }
  }

  for (const [name, text] of graph) {
    const chunkPath = path.join(CACHE_DIR, name)
    if (forceRefresh || !fs.existsSync(chunkPath)) {
      console.log(`[bootstrap] Caching StreamCorner asset ${name}`)
      fs.writeFileSync(chunkPath, text, 'utf8')
    }
  }

  const harnessPath = path.join(CACHE_DIR, 'harness.html')
  fs.writeFileSync(harnessPath, createHarnessHtml(catalogModule), 'utf8')
  return CACHE_DIR
}
