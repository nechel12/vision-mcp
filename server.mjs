#!/usr/bin/env node
/**
 * vision-mcp — give a non-vision coding agent "eyes" via free OpenRouter vision models.
 *
 * Zero dependencies (plain Node.js >= 18). Speaks MCP JSON-RPC over stdin/stdout.
 *
 * Tool:
 *   analyze_image(prompt, image)  — describe / OCR / answer a question about an image
 *
 * Model chain (free first, cheap paid as last resort):
 *   1..N  free vision models, each tried VISION_ATTEMPTS times (short backoff) before the next
 *   last  one cheap paid model, tried VISION_PAID_ATTEMPTS times (reliable, so more attempts)
 *   The first model that returns a non-empty answer wins. Returns which model served + attempts.
 *
 * Why base64: the free nemotron endpoint rejects http image URLs (404) but accepts base64
 * data URIs. So this server ALWAYS converts input (local file OR remote URL) to base64.
 *
 * Environment:
 *   OPENROUTER_API_KEY    required
 *   VISION_MODELS         comma-separated FREE models, tried in order (primary first)
 *   VISION_PAID_FALLBACK  single cheap paid model tried last (e.g. z-ai/glm-5.3-flash:floor)
 *   VISION_ATTEMPTS       attempts per FREE model (default 2)
 *   VISION_PAID_ATTEMPTS  attempts for the paid fallback (default 3)
 *   VISION_TIMEOUT_MS     per-attempt timeout ms (default 90000)
 *   VISION_MAX_MB         max input image size MB (default 20)
 *   VISION_ALLOWED_DIR    OPTIONAL. If set, local files must live under this dir (or the OS
 *                         temp dir). If unset, any local path is allowed (local dev tool).
 *   OPENROUTER_BASE_URL   default https://openrouter.ai/api/v1
 */

import { readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

const API = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '')
const API_KEY = process.env.OPENROUTER_API_KEY || ''
const FREE_MODELS = (process.env.VISION_MODELS || 'nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free')
  .split(',').map((s) => s.trim()).filter(Boolean)
const PAID = (process.env.VISION_PAID_FALLBACK || '').trim()
const FREE_ATTEMPTS = Math.max(1, Number(process.env.VISION_ATTEMPTS || 2))
const PAID_ATTEMPTS = Math.max(1, Number(process.env.VISION_PAID_ATTEMPTS || 3))
const TIMEOUT_MS = Math.max(5000, Number(process.env.VISION_TIMEOUT_MS || 90000))
const MAX_MB = Math.max(1, Number(process.env.VISION_MAX_MB || 20))
const ALLOWED_DIR = process.env.VISION_ALLOWED_DIR
  ? (() => { try { return realpathSync(process.env.VISION_ALLOWED_DIR) } catch { return path.resolve(process.env.VISION_ALLOWED_DIR) } })()
  : null

/* --------------------------------------------------------------- image load */

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp' }
function mimeOf(p) { const e = String(p).toLowerCase().match(/\.\w+$/)?.[0]; return (e && MIME[e]) || 'image/jpeg' }

async function toDataUri(input) {
  if (typeof input !== 'string' || !input) throw new Error('image is required (local path or http(s) URL)')
  if (/^https?:\/\//i.test(input)) {
    const r = await fetch(input)
    if (!r.ok) throw new Error(`fetch image failed: HTTP ${r.status}`)
    const ct = (r.headers.get('content-type') || '').split(';')[0] || 'image/jpeg'
    const buf = Buffer.from(await r.arrayBuffer())
    if (buf.length > MAX_MB * 1024 * 1024) throw new Error(`image exceeds ${MAX_MB}MB`)
    return `data:${ct};base64,${buf.toString('base64')}`
  }
  if (input.startsWith('data:')) return input
  // Local file. If VISION_ALLOWED_DIR is set, confine reads to it (+ temp).
  let abs = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input)
  if (ALLOWED_DIR) {
    let real; try { real = realpathSync(abs) } catch { real = path.resolve(abs) }
    const inside = (d) => { try { return realpathSync(d) } catch { return path.resolve(d) } }
    const roots = [ALLOWED_DIR, inside(tmpdir())]
    const ok = roots.some((d) => real === d || real.startsWith(d + path.sep))
    if (!ok) throw new Error(`File outside allowed directory (VISION_ALLOWED_DIR): ${input}`)
    abs = real
  }
  const buf = readFileSync(abs)
  if (buf.length > MAX_MB * 1024 * 1024) throw new Error(`image exceeds ${MAX_MB}MB`)
  return `data:${mimeOf(abs)};base64,${buf.toString('base64')}`
}

/* ------------------------------------------------------------------- call */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function callModel(model, imageUri, prompt, attempts) {
  const body = {
    model,
    messages: [{ role: 'user', content: [
      { type: 'text', text: prompt },
      { type: 'image_url', image_url: { url: imageUri } },
    ] }],
  }
  let lastErr = null
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const ac = new AbortController()
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
    try {
      const res = await fetch(`${API}/chat/completions`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ac.signal,
      })
      const text = await res.text()
      let json = null; try { json = JSON.parse(text) } catch {}
      if (res.ok) {
        const c = json?.choices?.[0]?.message?.content
        const content = Array.isArray(c) ? c.map((p) => p?.text || '').join('') : c
        if (content && content.trim()) return { content: content.trim(), servedModel: json?.model || model }
        lastErr = { status: res.status, message: 'empty response' }
      } else if (res.status === 401 || res.status === 403) {
        lastErr = { status: res.status, message: json?.error?.message || text.slice(0, 160) }
        return { authError: lastErr }
      } else {
        lastErr = { status: res.status, message: json?.error?.message || text.slice(0, 160) }
      }
    } catch (e) {
      lastErr = { status: 0, message: e.name === 'AbortError' ? `timeout ${TIMEOUT_MS}ms` : e.message }
    } finally {
      clearTimeout(timer)
    }
    if (attempt < attempts) {
      const wait = Math.min(4000, 400 * Math.pow(2, attempt - 1)) + Math.floor(Math.random() * 300)
      await sleep(wait)
    }
  }
  return { fail: lastErr }
}

async function analyze(prompt, image) {
  if (!API_KEY) throw new Error('OPENROUTER_API_KEY is not set')
  const imageUri = await toDataUri(image)
  const chain = [...FREE_MODELS.map((m) => ({ model: m, attempts: FREE_ATTEMPTS, free: true }))]
  if (PAID) chain.push({ model: PAID, attempts: PAID_ATTEMPTS, free: false })

  const tried = []
  let authBlocked = false
  for (const step of chain) {
    const r = await callModel(step.model, imageUri, prompt, step.attempts)
    if (r.content) return { content: r.content, servedModel: r.servedModel, attempts: tried.length + 1, tried }
    tried.push({ model: step.model, free: step.free, status: r.fail?.status ?? r.authError?.status ?? 'ERR', message: (r.fail?.message ?? r.authError?.message ?? '').slice(0, 120) })
    if (r.authError) { authBlocked = true; break }
  }
  const e = new Error(
    `vision failed across ${tried.length} model(s)` +
    (authBlocked ? ' (auth/permission error — check OPENROUTER_API_KEY)' : ' — all free models rate-limited/down and paid fallback unavailable')
  )
  e.detail = tried
  throw e
}

/* ------------------------------------------------------------------ tools */

const TOOLS = [
  {
    name: 'analyze_image',
    description:
      'Get a text answer about an image using a vision model chain (free OpenRouter models first, ' +
      'then a cheap paid fallback, with retries). Use it when you cannot see the image yourself: ' +
      'UI/design review, OCR, "what is on this screenshot", comparing a render to an expectation. ' +
      'Pass a local file path or an http(s) URL. YOU write the prompt for your task. ' +
      'Returns { content, servedModel, attempts, tried }.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'Instruction/question for the vision model (you write this)' },
        image: { type: 'string', description: 'Local file path (absolute or relative) or http(s) URL of the image' },
      },
      required: ['prompt', 'image'],
    },
  },
]

/* -------------------------------------------------------------- transport */

function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n') }
function reply(id, result) { send({ jsonrpc: '2.0', id, result }) }
function replyError(id, code, message, data) { send({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } }) }
function toolResult(payload) { return { content: [{ type: 'text', text: typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2) }] } }

async function handle(msg) {
  const { id, method, params } = msg
  if (method === 'initialize') {
    reply(id, { protocolVersion: params?.protocolVersion || '2024-11-05', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'vision-mcp', version: '1.0.0' } })
    return
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
  if (method === 'ping') return reply(id, {})
  if (method === 'resources/list') return reply(id, { resources: [] })
  if (method === 'prompts/list') return reply(id, { prompts: [] })
  if (method === 'logging/setLevel') return reply(id, {})
  if (method === 'tools/list') return reply(id, { tools: TOOLS })
  if (method === 'tools/call') {
    const name = params?.name
    if (name === 'analyze_image') {
      try {
        const a = params.arguments || {}
        reply(id, toolResult(await analyze(a.prompt, a.image)))
      } catch (e) {
        reply(id, { content: [{ type: 'text', text: JSON.stringify({ error: e.message, ...(e.detail ? { detail: e.detail } : {}) }, null, 2) }], isError: true })
      }
      return
    }
    return replyError(id, -32602, `Unknown tool: ${name}`)
  }
  if (id !== undefined) replyError(id, -32601, `Method not found: ${method}`)
}

let buffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  buffer += chunk
  let nl
  while ((nl = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, nl).trim(); buffer = buffer.slice(nl + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    handle(msg)
  }
})
process.stdin.on('end', () => process.exit(0))
process.stderr.write(`[vision-mcp] ready (free: ${FREE_MODELS.length}×${FREE_ATTEMPTS}, paid: ${PAID || 'none'}×${PAID_ATTEMPTS})\n`)