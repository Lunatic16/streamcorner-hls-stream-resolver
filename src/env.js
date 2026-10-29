import path from 'node:path'
import os from 'node:os'

export const port = Number(process.env.PORT) || 3000
export const host = process.env.HOST || '0.0.0.0'

export const USER_AGENT =
  process.env.USER_AGENT ||
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export const CACHE_DIR =
  process.env.CACHE_DIR ||
  path.join(os.homedir(), '.cache', 'streamcorner')
