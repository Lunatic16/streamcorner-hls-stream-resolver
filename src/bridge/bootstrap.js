import fs from 'node:fs'
import path from 'node:path'
import { ASSETS, HARNESS_HTML, WORKER_CHUNKS } from './constants.js'
import { CACHE_DIR, USER_AGENT } from '../env.js'

export async function ensureWorkerChunks(forceRefresh = false) {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true })
  }

  for (const chunk of WORKER_CHUNKS) {
    const chunkPath = path.join(CACHE_DIR, chunk)
    if (forceRefresh || !fs.existsSync(chunkPath)) {
      const url = `${ASSETS}${chunk}`
      console.log(`[bootstrap] Fetching worker chunk ${url}...`)
      const res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          Accept: '*/*',
          Referer: 'https://streamcorner.st/',
        },
      })
      if (!res.ok) {
        throw new Error(`Failed to fetch worker chunk ${chunk}: HTTP ${res.status}`)
      }
      const buffer = Buffer.from(await res.arrayBuffer())
      fs.writeFileSync(chunkPath, buffer)
    }
  }

  const harnessPath = path.join(CACHE_DIR, 'harness.html')
  fs.writeFileSync(harnessPath, HARNESS_HTML, 'utf8')
  return CACHE_DIR
}
