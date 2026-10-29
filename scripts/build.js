import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const dist = path.join(root, 'dist')

fs.rmSync(dist, { recursive: true, force: true })
fs.mkdirSync(dist)

fs.cpSync(path.join(root, 'public'), path.join(dist, 'public'), { recursive: true })
fs.cpSync(path.join(root, 'src'), path.join(dist, 'src'), { recursive: true })

for (const file of ['package.json', 'package-lock.json']) {
  const src = path.join(root, file)
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(dist, file))
}

execSync('npm install --omit=dev --no-audit --no-fund', { cwd: dist, stdio: 'inherit' })

console.log(`\nBuild complete: ${path.relative(root, dist)}/`)
console.log('Run standalone with: cd dist && npm start')
