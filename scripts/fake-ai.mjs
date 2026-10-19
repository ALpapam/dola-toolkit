// Minimal OpenAI-compatible fake server for local AI client testing.
// node scripts/fake-ai.mjs [port]
import { createServer } from 'node:http'

const port = Number(process.argv[2] ?? 8791)

const server = createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  let body = ''
  req.on('data', (c) => (body += c))
  req.on('end', () => {
    let parsed = {}
    try {
      parsed = JSON.parse(body)
    } catch {
      /* ignore */
    }
    const wantsJson = parsed?.response_format?.type === 'json_object'
    // simulate a server that rejects response_format
    if (wantsJson && req.headers['x-fake-strict'] !== '1') {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'response_format is not supported' } }))
      return
    }
    const userMsg = parsed?.messages?.find((m) => m.role === 'user')?.content ?? ''
    const content = wantsJson
      ? JSON.stringify({ groups: [{ name: '星海系列', bookIds: [], confidence: 0.9, reason: '同名系列' }] })
      : `pong: ${String(userMsg).slice(0, 40)}`
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(
      JSON.stringify({
        id: 'chatcmpl-test',
        object: 'chat.completion',
        model: parsed?.model ?? 'fake',
        choices: [{ index: 0, message: { role: 'assistant', content }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 }
      })
    )
  })
})

server.listen(port, '127.0.0.1', () => console.log(`fake-ai listening on http://127.0.0.1:${port}/v1`))
