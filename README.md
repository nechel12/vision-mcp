# vision-mcp

Give a **non-vision coding agent** (OpenCode, Claude Code, Cursor, Cline, …) the ability to
"see" an image — for UI/design review, OCR, "what's on this screenshot", or comparing a
render to an expectation — using **free OpenRouter vision models**.

Zero dependencies. Speaks MCP over stdio. The agent calls one tool:

```
analyze_image(prompt, image)  ->  { content, servedModel, attempts, tried }
```

- `image` = local file path **or** http(s) URL.
- The server converts everything to **base64** (the free nemotron endpoint rejects http image
  URLs but accepts base64), then calls OpenRouter.
- **Model chain:** several free vision models first (each with retries), then a cheap paid
  fallback. First model that answers wins; the result says which one served it.

## Why

Agents without native vision cannot judge whether a game/UI *looks* good. Numeric layout
checks catch clipping, not beauty. This tool lets the agent itself run a **design review** on
Playwright screenshots before shipping — no need to pick a vision *subagent*.

## Models (defaults, override via env)

Free (tried in order, 2 attempts each):
- `nvidia/nemotron-3.5-super-vl:free`
- `google/gemma-4-31b-it:free`
- `nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`
- `google/gemma-4-26b-a4b-it:free`

Cheap paid fallback (last resort, 3 attempts):
- `z-ai/glm-5.3-flash:floor`

Free endpoints are rate-limited; the paid fallback guarantees an answer. Check current free
models at https://openrouter.ai/models (filter input modality = image, price = 0).

## Install

### Option A — run from source (simplest)

```bash
git clone https://github.com/<you>/vision-mcp
cd vision-mcp
# no npm install needed (zero deps)
export OPENROUTER_API_KEY=sk-or-v1-...
node server.mjs
```

### Option B — MCP client config

OpenCode (`opencode.json` / `opencode.jsonc`):

```jsonc
{
  "mcp": {
    "servers": {
      "vision": {
        "type": "local",
        "command": ["node", "/abs/path/to/vision-mcp/server.mjs"],
        "environment": {
          "OPENROUTER_API_KEY": "sk-or-v1-...",
          "VISION_MODELS": "nvidia/nemotron-3.5-super-vl:free,google/gemma-4-31b-it:free",
          "VISION_PAID_FALLBACK": "z-ai/glm-5.3-flash:floor"
        }
      }
    }
  }
}
```

Claude Desktop / Cursor / Cline use an equivalent `mcpServers` block (command + env).
See `.env.example` for all options.

## Configuration (environment)

| Variable | Default | Meaning |
|---|---|---|
| `OPENROUTER_API_KEY` | — (required) | OpenRouter key |
| `VISION_MODELS` | nemotron,gemma-31b,… | comma-separated free models, in order |
| `VISION_PAID_FALLBACK` | (empty) | one cheap paid model tried last |
| `VISION_ATTEMPTS` | `2` | attempts per free model |
| `VISION_PAID_ATTEMPTS` | `3` | attempts for the paid fallback |
| `VISION_TIMEOUT_MS` | `90000` | per-attempt timeout |
| `VISION_MAX_MB` | `20` | max input image size |
| `VISION_ALLOWED_DIR` | (unset) | if set, local reads confined to this dir (+ OS temp) |
| `OPENROUTER_BASE_URL` | `https://openrouter.ai/api/v1` | API base |

## Security

- The API key is read **only from the environment** — never bundled, never logged.
- If `VISION_ALLOWED_DIR` is unset, the tool can read **any local file path** (it's a local
  dev tool). **Set `VISION_ALLOWED_DIR` to sandbox it** to a screenshots folder if you want
  to restrict reads.
- Images are sent to OpenRouter (the model provider you select). Don't feed secrets/screenshots
  you wouldn't send to a third party.

## Programmatic use (any MCP host)

The tool is standard MCP; the agent writes its own `prompt` per task (e.g. "harsh design
review: layout, hierarchy, biggest problem, polish 1–5"). A ready-made design-review prompt
lives in the Playgama skill (`templates/vision-design-review-prompt.md`).

## License

MIT — see [LICENSE](LICENSE).