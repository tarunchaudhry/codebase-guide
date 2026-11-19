/** Secret-pattern scan run over every code snippet before it's embedded in the report. */

const MARK = '«redacted»';

const PATTERNS: [string, RegExp][] = [
  ['private-key', /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g],
  ['aws-access-key', /\b(AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}\b/g],
  ['github-token', /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{40,}\b/g],
  ['gitlab-token', /\bglpat-[A-Za-z0-9_-]{20,}\b/g],
  ['slack-token', /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g],
  ['stripe-key', /\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]{16,}\b/g],
  ['anthropic-key', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g],
  ['openai-key', /\bsk-(proj-)?[A-Za-z0-9_-]{32,}\b/g],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['npm-token', /\bnpm_[A-Za-z0-9]{36}\b/g],
  ['sendgrid-key', /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g],
  ['twilio-key', /\bSK[0-9a-fA-F]{32}\b/g],
  ['jwt', /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g],
  // scheme://user:password@host — keep the scheme and host, drop the credentials.
  ['url-credentials', /\b([a-z][a-z0-9+.-]*:\/\/)[^\s:/@'"`]+:[^\s@'"`]+@/gi],
];

/** `password = "hunter2"`, `apiKey: 'abc…'`: a secret-ish name assigned a non-empty string literal. */
const ASSIGN = /\b([\w-]*(?:pass(?:word|wd)?|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|auth[_-]?key|credentials?)[\w-]*)(\s*[:=]\s*|\s*=>\s*)(["'`])([^"'`\n]{4,})\3/gi;
const QUOTED = /(["'`])([A-Za-z0-9+/=_\-.]{20,})\1/g;

function entropy(s: string): number {
  const freq = new Map<string, number>();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) { const p = n / s.length; h -= p * Math.log2(p); }
  return h;
}

/** High-entropy literal: long, mixed character classes, not a path/identifier/URL-ish word. */
export function looksSecret(s: string): boolean {
  if (s.length < 20 || /^[a-z]+([._-][a-z]+)*$/i.test(s) || /^[./]|\/\w+\//.test(s) || /^\d+$/.test(s)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /\d/, /[+/=_-]/].filter((r) => r.test(s)).length;
  const hex = /^[0-9a-f]+$/i.test(s);
  return hex ? s.length >= 32 && entropy(s) > 3.0 : classes >= 3 && entropy(s) > 4.0;
}

export interface RedactResult { text: string; count: number; kinds: string[] }

export function redact(text: string): RedactResult {
  let count = 0;
  const kinds = new Set<string>();
  let out = text;
  for (const [kind, re] of PATTERNS) {
    out = out.replace(re, (m, ...g: unknown[]) => {
      count++; kinds.add(kind);
      return kind === 'url-credentials' ? `${String(g[0])}${MARK}@` : MARK;
    });
  }
  out = out.replace(ASSIGN, (m, name: string, op: string, q: string, val: string) => {
    // ponytail: plain lowercase words ("password", "access_token") are field names, not secrets; real ones rarely look like that
    if (val === MARK || /^[a-z_.-]{1,15}$/.test(val) || /^(\$\{|process\.env|os\.environ|env\(|<|\*+$|x+$|changeme$|example|your[_-]|placeholder|test$|dummy)/i.test(val)) return m;
    count++; kinds.add('assigned-secret');
    return `${name}${op}${q}${MARK}${q}`;
  });
  out = out.replace(QUOTED, (m, q: string, val: string) => {
    if (!looksSecret(val)) return m;
    count++; kinds.add('high-entropy');
    return `${q}${MARK}${q}`;
  });
  return { text: out, count, kinds: [...kinds].sort() };
}
