// Robust minimal HTTP proxy for testing (handles absolute-URI + CONNECT).
import { createServer, request } from 'node:http'
import { connect } from 'node:net'

const PORT = Number(process.argv[2] ?? 18099)

const server = createServer((req, res) => {
  let target
  try {
    target = new URL(req.url)
  } catch {
    res.writeHead(400, { 'Content-Length': '0' }).end()
    return
  }
  const headers = { ...req.headers }
  delete headers['proxy-connection']
  delete headers['proxy-authorization']
  headers.host = target.host
  headers.connection = 'close'

  const upstreamReq = request(
    {
      host: target.hostname,
      port: Number(target.port || 80),
      path: target.pathname + target.search,
      method: req.method,
      headers
    },
    (upstreamRes) => {
      const outHeaders = { ...upstreamRes.headers }
      delete outHeaders['transfer-encoding']
      delete outHeaders['connection']
      res.writeHead(upstreamRes.statusCode ?? 502, outHeaders)
      upstreamRes.pipe(res)
    }
  )
  upstreamReq.on('error', () => {
    if (!res.headersSent) res.writeHead(502, { 'Content-Length': '0' })
    res.end()
  })
  // Drain the request body (GET has none, but POST would).
  req.on('data', () => undefined)
  req.on('end', () => upstreamReq.end())
})

server.on('connect', (req, clientSocket, head) => {
  const parts = (req.url ?? '').split(':')
  const host = parts[0]
  const port = Number(parts[1] || 443)
  clientSocket.on('error', () => undefined)
  const serverSocket = connect(port, host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
    if (head?.length) serverSocket.write(head)
    serverSocket.pipe(clientSocket)
    clientSocket.pipe(serverSocket)
  })
  serverSocket.on('error', () => {
    try {
      clientSocket.end('HTTP/1.1 502 Bad Gateway\r\n\r\n')
    } catch {
      /* ignore */
    }
  })
})

server.on('clientError', (_e, socket) => {
  try {
    socket.destroy()
  } catch {
    /* ignore */
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`http proxy on 127.0.0.1:${PORT}`))
