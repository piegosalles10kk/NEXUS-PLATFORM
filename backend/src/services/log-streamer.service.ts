/**
 * log-streamer.service.ts  (Sprint 17.3)
 *
 * Intercepts Node.js process-level errors and console.error calls,
 * stores a rolling in-memory buffer, and streams each entry to
 * the Sentinel frontend via Socket.io (sentinel:log events).
 *
 * This is intentionally lightweight — no Pino/Winston dependency.
 * For production, replace the in-memory ring buffer with a Redis stream.
 */

import { getIo } from './agent-ws.service';

export interface LogEntry {
  level:     'error' | 'warn' | 'fatal';
  message:   string;
  nodeId?:   string;   // set when the error is tagged to a specific node
  timestamp: string;
}

const MAX_BUFFER = 500;
const buffer: LogEntry[] = [];

function push(entry: LogEntry) {
  buffer.push(entry);
  if (buffer.length > MAX_BUFFER) buffer.shift();
  // Stream to all Sentinel clients in real-time
  try {
    getIo()?.emit('sentinel:log', entry);
  } catch {
    // IO not yet initialized — ignore
  }
}

/** Returns the last `limit` log entries (newest last). */
export function recentBackendLogs(limit = 100): LogEntry[] {
  return buffer.slice(-Math.min(limit, MAX_BUFFER));
}

// ── Intercept console.error ───────────────────────────────────────────────────

const _origError = console.error.bind(console);
console.error = (...args: any[]) => {
  _origError(...args);
  const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  push({ level: 'error', message, timestamp: new Date().toISOString() });
};

const _origWarn = console.warn.bind(console);
console.warn = (...args: any[]) => {
  _origWarn(...args);
  const message = args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ');
  push({ level: 'warn', message, timestamp: new Date().toISOString() });
};

// ── Catch uncaught exceptions ─────────────────────────────────────────────────

process.on('uncaughtException', (err) => {
  push({ level: 'fatal', message: `uncaughtException: ${err.message}\n${err.stack}`, timestamp: new Date().toISOString() });
});

process.on('unhandledRejection', (reason) => {
  push({ level: 'error', message: `unhandledRejection: ${String(reason)}`, timestamp: new Date().toISOString() });
});

/** Tag a log entry with a specific nodeId (called from agent-ws.service). */
export function pushNodeLog(nodeId: string, message: string, level: LogEntry['level'] = 'error') {
  push({ level, message, nodeId, timestamp: new Date().toISOString() });
}
