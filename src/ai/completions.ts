import { Ai } from '@cloudflare/workers-types'
import { Tool } from './tools'

const MODEL = '@cf/qwen/qwen3.8-27b'
const SYSTEM_PROMPT = [
  'あなたはチャットボットです。短い返答が望ましいです。特に指示が無い場合は日本語で応答してください。',
  '',
  '利用可能なツールがあれば必ず積極的に使ってください。とくに以下を厳守してください:',
  '- ユーザーが「画像」「絵」「写真」を求めたら、必ず search_image ツールを呼ぶこと。架空の結果 (例: 「画像見つかりました」だけ返す) は絶対にしてはいけません。',
  '- ユーザーが選択肢の中から 1 つ選ぶよう求めたら、必ず pick_one ツールを呼ぶこと。ただし「シャッフル」「順番を決めて」「並び替え」のような複数件の順序付け依頼にはこの tool は使えないので、tool を呼ばずに自然文で応答すること。',
  '- tool を呼ぶときは必ず構造化された tool_call として呼び、JSON をメッセージ本文に書かないこと。',
].join('\n')
const MAX_TOKENS = 512
// Qwen3.8 は既定で思考モードが有効で、reasoning が max_tokens を食い潰して
// 本文が途中で切れたり応答が数十秒かかる。`/no_think` soft switch は効かないため
// chat template 側で明示的に無効化する。
const CHAT_TEMPLATE_KWARGS = { enable_thinking: false }

type AiRunner = { run: (model: string, body: unknown) => Promise<unknown> }

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export class LlamaChat {
  constructor(private readonly ai: Ai) {}

  async completions(prompt: string): Promise<string> {
    return this.chat([{ role: 'user', content: prompt }])
  }

  async chat(messages: ChatMessage[]): Promise<string> {
    return extractText(await this.run(messages))
  }

  // The generated workers-types overloads don't cover every model id or
  // `chat_template_kwargs`, so call through an untyped runner.
  private run(messages: ChatMessage[], extra: Record<string, unknown> = {}): Promise<unknown> {
    return (this.ai as unknown as AiRunner).run(MODEL, {
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      max_tokens: MAX_TOKENS,
      temperature: 0.8,
      chat_template_kwargs: CHAT_TEMPLATE_KWARGS,
      ...extra,
    })
  }

  async chatWithTools(messages: ChatMessage[], tools: Tool[]): Promise<string> {
    // Workers AI accepts tools wrapped in OpenAI's shape
    // { type: 'function', function: { name, description, parameters } }
    // but the tool_calls it returns vary by model (wrapped or flat), and
    // @cloudflare/ai-utils' runWithTools handles neither reliably, so we
    // drive the loop ourselves.
    const wrappedTools = tools.map((t) => ({
      type: 'function' as const,
      function: { name: t.name, description: t.description, parameters: t.parameters },
    }))
    const raw = await this.run(messages, { tools: wrappedTools })
    const result = normalizeResult(raw)
    let toolCalls = parseToolCalls(result.tool_calls)
    if (toolCalls.length === 0) {
      // Some Workers AI models sometimes emit the tool_call as a JSON
      // literal in `response` instead of populating `tool_calls`. Parse it
      // out so the tool actually fires instead of leaking raw JSON to Slack.
      toolCalls = parseToolCallsFromResponseText(result.response)
    }
    if (toolCalls.length === 0) return extractText(result)

    // A tool was invoked — return the tool's own output verbatim and skip the
    // follow-up "AI commentary" turn. Tools that already posted to Slack as a
    // side effect (e.g. search_image) return an empty string so the caller
    // posts nothing additional.
    const outputs: string[] = []
    for (const call of toolCalls) {
      const tool = tools.find((t) => t.name === call.name)
      const fn = tool?.function
      const out = fn ? await fn(call.arguments) : `unknown tool: ${call.name}`
      if (out) outputs.push(out)
    }
    return outputs.join('\n')
  }
}

type LegacyResult = { response?: unknown; tool_calls?: unknown }

// Newer Workers AI models (e.g. qwen3.8-27b) answer in OpenAI's
// chat.completion shape: { choices: [{ message: { content, tool_calls } }] }.
// Older ones return { response, tool_calls }. Flatten the former into the
// latter so the rest of the pipeline handles a single shape.
function normalizeResult(raw: unknown): LegacyResult {
  if (typeof raw === 'string') return { response: raw }
  if (!raw || typeof raw !== 'object') return {}
  const choices = (raw as { choices?: unknown }).choices
  if (!Array.isArray(choices) || choices.length === 0) return raw as LegacyResult
  const message = (choices[0] as { message?: unknown })?.message
  if (!message || typeof message !== 'object') return {}
  const { content, tool_calls } = message as { content?: unknown; tool_calls?: unknown }
  return { response: content, tool_calls }
}

function extractText(raw: unknown): string {
  const { response } = normalizeResult(raw)
  if (typeof response === 'string') {
    return response.trim()
  }
  throw new Error(`Unexpected Workers AI response shape: ${safeStringify(raw)}`)
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value).slice(0, 200)
  } catch {
    return String(value).slice(0, 200)
  }
}

type ParsedToolCall = { id?: string; name: string; arguments: Record<string, unknown> }

// Some Workers AI models return tool_calls in OpenAI's wrapped shape:
//   { id, type: 'function', function: { name, arguments } }
// where arguments is sometimes a JSON-encoded string, while others return
// the flat { name, arguments } shape directly. Accept both.
function parseToolCalls(raw: unknown): ParsedToolCall[] {
  if (!Array.isArray(raw)) return []
  return raw.flatMap((entry): ParsedToolCall[] => {
    if (!entry || typeof entry !== 'object') return []
    const e = entry as { id?: unknown; function?: unknown; name?: unknown; arguments?: unknown }
    const fn = (e.function && typeof e.function === 'object' ? e.function : e) as {
      name?: unknown
      arguments?: unknown
    }
    if (typeof fn.name !== 'string') return []
    let args: Record<string, unknown> = {}
    if (typeof fn.arguments === 'string') {
      try {
        args = JSON.parse(fn.arguments)
      } catch {
        args = {}
      }
    } else if (fn.arguments && typeof fn.arguments === 'object') {
      args = fn.arguments as Record<string, unknown>
    }
    return [{ id: typeof e.id === 'string' ? e.id : undefined, name: fn.name, arguments: args }]
  })
}

function parseToolCallsFromResponseText(response: unknown): ParsedToolCall[] {
  if (typeof response !== 'string') return []
  const trimmed = response.trim()
  if (!trimmed.startsWith('{')) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return []
  }
  if (!parsed || typeof parsed !== 'object') return []
  const obj = parsed as { name?: unknown; parameters?: unknown; arguments?: unknown }
  if (typeof obj.name !== 'string') return []
  const argsRaw = obj.parameters ?? obj.arguments
  const args =
    argsRaw && typeof argsRaw === 'object' && !Array.isArray(argsRaw) ? (argsRaw as Record<string, unknown>) : {}
  return [{ name: obj.name, arguments: args }]
}
