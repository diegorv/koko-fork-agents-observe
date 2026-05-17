// app/server/src/index.ts
import type { Server } from 'http'
import { serve } from '@hono/node-server'
import { createApp } from './app'
import { createStore } from './storage'
import { attachWebSocket, broadcastToSession, broadcastToAll, broadcastActivity } from './websocket'
import { config } from './config'
import { startConsumerSweep } from './consumer-tracker'

const store = createStore()
const PORT = config.port

// Repair any rows with broken foreign keys before serving traffic.
// Logs what it found so the user knows if state was unexpected.
store.repairOrphans().then((result) => {
  const total =
    result.sessionsReassigned +
    result.agentsDeleted +
    result.agentsReparented +
    result.eventsDeleted
  if (total > 0) {
    console.log(
      `[startup] Repaired orphaned rows: ` +
        `${result.sessionsReassigned} sessions reassigned to 'unknown', ` +
        `${result.agentsDeleted} agents deleted, ` +
        `${result.agentsReparented} agents reparented, ` +
        `${result.eventsDeleted} events deleted`,
    )
  }
})

const app = createApp(store, broadcastToSession, broadcastToAll, broadcastActivity)
const HOST = config.bindHost

function start(retries = 3) {
  const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
    console.log(`Server running on http://${HOST}:${PORT}`)
    console.log(`POST events: http://${HOST}:${PORT}/api/events`)
    if (HOST !== '0.0.0.0' && HOST !== '127.0.0.1' && HOST !== 'localhost') {
      console.log(`Bound to custom host: ${HOST}`)
    } else if (HOST === '0.0.0.0') {
      console.log(
        '[security] Server is reachable from any network interface. ' +
          'Set AGENTS_OBSERVE_BIND_HOST=127.0.0.1 to restrict to localhost.',
      )
    }
  })

  ;(server as unknown as Server).on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE' && retries > 0) {
      console.log(`Port ${PORT} in use, retrying in 1s... (${retries} left)`)
      setTimeout(() => start(retries - 1), 1000)
    } else {
      console.error(err)
      process.exit(1)
    }
  })

  attachWebSocket(server as unknown as Server)
  startConsumerSweep()
}

start()
