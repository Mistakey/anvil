// 工具调用的一行摘要（命令、路径或模式），密钥先遮掉再存。
// 遮密钥的规则和 describeInput 取自 flightdeck（hooks/core.ts 的 SECRETS、redact、describeInput），
// MIT License, Copyright (c) 2026 Stephen Casella。子 agent 的"最近调用"和自动模式拒绝的摘要共用。

const SECRETS: [RegExp, string][] = [
  [/(authorization\s*[:=]\s*)(bearer\s+|basic\s+)?\S+/gi, '$1$2•••'],
  [/\b(bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, '$1 •••'],
  [/\b(sk|pk|rk|ghp|gho|ghs|github_pat|xox[abprs])[-_][A-Za-z0-9_-]{8,}/g, '•••'],
  [/((?:api[_-]?key|access[_-]?token|token|secret|password|passwd|pwd)\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1•••'],
  [/(--(?:token|password|api-key|secret)[= ])\S+/gi, '$1•••'],
  [/(\b[A-Z][A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)=)\S+/g, '$1•••'],
  [/(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s@]+@/gi, '$1•••@'],
]

/** 遮掉文本里的密钥 */
export const redact = (text: string) => SECRETS.reduce((out, [pattern, to]) => out.replace(pattern, to), text)

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null

/** 一次调用是关于什么的：命令、路径（取最后两段）、模式、网址或描述；已遮掉密钥，空白压成一个空格 */
export function describeInput(input: unknown): string {
  const fields = isObject(input) ? input : {}
  const path = typeof fields.file_path === 'string' ? fields.file_path.split(/[\\/]/).slice(-2).join('/') : ''
  const what =
    typeof fields.command === 'string'
      ? fields.command
      : path ||
        (typeof fields.pattern === 'string'
          ? fields.pattern
          : typeof fields.url === 'string'
            ? fields.url
            : typeof fields.description === 'string'
              ? fields.description
              : '')
  return redact(what).replace(/\s+/g, ' ').trim()
}
