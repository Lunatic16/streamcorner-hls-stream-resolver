export function json(res, status, body) {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': '*',
  })
  res.end(JSON.stringify(body))
}

export function text(res, status, msg) {
  if (res.headersSent) return
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  })
  res.end(msg)
}

export async function readBody(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  if (!raw.trim()) return {}
  return JSON.parse(raw)
}
