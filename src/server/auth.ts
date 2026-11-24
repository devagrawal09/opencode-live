import type { Plugin } from "@opencode/plugin"

import type { Auth } from "./live-chatgpt"

type Context = Plugin.Context

export type AuthResult = { ok: true; auth: Auth; plan?: string } | { ok: false; reason: string }

interface Claims {
  chatgpt_account_id?: string
  chatgpt_plan_type?: string
}

export function claims(token: string): Claims {
  const part = token.split(".")[1]
  if (!part) return {}
  try {
    const payload = JSON.parse(Buffer.from(part, "base64url").toString()) as Record<string, unknown>
    const auth = (payload["https://api.openai.com/auth"] ?? {}) as Claims
    return {
      chatgpt_account_id: auth.chatgpt_account_id ?? (payload.chatgpt_account_id as string | undefined),
      chatgpt_plan_type: auth.chatgpt_plan_type,
    }
  } catch {
    return {}
  }
}

const NOT_SIGNED_IN =
  'GPT-Live in ChatGPT mode needs your ChatGPT subscription. Run /connect, choose OpenAI, then "Codex browser (legacy)". Or set mode to "api" to use an OpenAI API key.'
const NO_ACCOUNT =
  'Your ChatGPT sign-in has no account ID, which GPT-Live needs. "Sign in with ChatGPT" logins hide it. Connect OpenAI again with "Codex browser (legacy)".'

/**
 * Finds the ChatGPT sign-in among the OpenAI connections. OpenCode refreshes the
 * access token during resolve when it is close to expiring, so resolve before each call.
 */
export async function resolveAuth(ctx: Context): Promise<AuthResult> {
  const integration = await ctx.integration.get({ integrationID: "openai" as never }).catch(() => undefined)
  const connections = (integration?.data as { connections?: unknown[] } | undefined)?.connections ?? []
  const oauth = connections.filter(
    (connection): connection is { type: "credential"; id: string; label: string; method: "oauth" } =>
      (connection as { type?: string }).type === "credential" && (connection as { method?: string }).method === "oauth",
  )
  if (oauth.length === 0) return { ok: false, reason: NOT_SIGNED_IN }
  const active = await ctx.integration.connection.active("openai").catch(() => undefined)
  const ordered = oauth.toSorted(
    (a, b) => Number(b.id === (active as { id?: string })?.id) - Number(a.id === (active as { id?: string })?.id),
  )
  // Resolve every connection at once, then take the first usable one in priority order.
  const credentials = await Promise.all(
    ordered.map((connection) => ctx.integration.connection.resolve(connection as never).catch(() => undefined)),
  )
  for (const credential of credentials) {
    if (!credential || credential.type !== "oauth") continue
    const claim = claims(credential.access)
    const metadata = (credential.metadata ?? {}) as Record<string, unknown>
    const accountID =
      (typeof metadata.accountID === "string" && metadata.accountID) ||
      (typeof metadata.accountId === "string" && metadata.accountId) ||
      claim.chatgpt_account_id
    if (!accountID) continue
    return { ok: true, auth: { token: credential.access, accountID }, plan: claim.chatgpt_plan_type }
  }
  return {
    ok: false,
    reason: credentials.some((credential) => credential?.type === "oauth") ? NO_ACCOUNT : NOT_SIGNED_IN,
  }
}

export const NO_API_KEY =
  "GPT-Live needs an OpenAI API key: /connect → OpenAI → API key, or set mode to chatgpt to use a ChatGPT plan."

export type KeySource = "option" | "connection" | "env"

export type ApiKeyResult = { ok: true; key: string; source: KeySource } | { ok: false; reason: string }

type ConnectionLike = { type?: string; id?: string; method?: string; name?: string }

const usable = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && !/^\{env:[^}]*\}$/.test(value.trim())

/**
 * The API key for `api` mode, in order: the plugin's `apiKey` option (OpenCode substitutes `{env:NAME}` in config),
 * OpenCode's OpenAI API-key connections (the active one first, then env-backed ones), then `OPENAI_API_KEY` in the
 * server's environment. The key never leaves the server.
 */
export async function resolveApiKey(
  ctx: Context,
  option: unknown,
  env: Record<string, string | undefined> = process.env,
): Promise<ApiKeyResult> {
  if (usable(option)) return { ok: true, key: option.trim(), source: "option" }
  const integration = await ctx.integration.get({ integrationID: "openai" as never }).catch(() => undefined)
  const connections = ((integration?.data as { connections?: unknown[] } | undefined)?.connections ??
    []) as ConnectionLike[]
  const candidates = connections.filter(
    (connection) => (connection.type === "credential" && connection.method === "key") || connection.type === "env",
  )
  if (candidates.length) {
    const active = (await ctx.integration.connection.active("openai").catch(() => undefined)) as
      | ConnectionLike
      | undefined
    const same = (connection: ConnectionLike) =>
      !!active && connection.type === active.type && connection.id === active.id && connection.name === active.name
    // Saved keys before env-backed ones; the active connection first.
    const rank = (connection: ConnectionLike) => (same(connection) ? 0 : connection.type === "credential" ? 1 : 2)
    const ordered = candidates.toSorted((a, b) => rank(a) - rank(b))
    const credentials = await Promise.all(
      ordered.map((connection) => ctx.integration.connection.resolve(connection as never).catch(() => undefined)),
    )
    for (const credential of credentials) {
      if (credential?.type === "key" && usable(credential.key))
        return { ok: true, key: credential.key.trim(), source: "connection" }
    }
  }
  if (usable(env.OPENAI_API_KEY)) return { ok: true, key: env.OPENAI_API_KEY.trim(), source: "env" }
  return { ok: false, reason: NO_API_KEY }
}
