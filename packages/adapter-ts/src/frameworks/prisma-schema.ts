export interface PrismaField { name: string; type: string; relation?: string; line: number; target?: string }
export interface PrismaModel { name: string; line: number; endLine: number; fields: PrismaField[]; doc?: string }

const SCALARS = new Set(['String', 'Boolean', 'Int', 'BigInt', 'Float', 'Decimal', 'DateTime', 'Json', 'Bytes', 'Unsupported']);

/** Parses `model X { … }` blocks of a .prisma file. Enums/types are recognised so their fields aren't treated as relations. */
export function parsePrismaSchema(text: string): PrismaModel[] {
  const lines = text.split(/\r?\n/);
  const blocks: { kind: string; name: string; start: number; end: number; doc?: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(model|enum|type|view)\s+(\w+)\s*\{/.exec(lines[i]!);
    if (!m) continue;
    let j = i + 1;
    while (j < lines.length && !/^\s*\}/.test(lines[j]!)) j++;
    const doc = i > 0 ? /^\s*\/\/\/\s?(.*)$/.exec(lines[i - 1]!)?.[1] : undefined;
    blocks.push({ kind: m[1]!, name: m[2]!, start: i, end: j, ...(doc ? { doc } : {}) });
    i = j;
  }
  const modelNames = new Set(blocks.filter((b) => b.kind === 'model' || b.kind === 'view').map((b) => b.name));
  const models: PrismaModel[] = [];
  for (const b of blocks) {
    if (b.kind !== 'model' && b.kind !== 'view') continue;
    const fields: PrismaField[] = [];
    for (let i = b.start + 1; i < b.end; i++) {
      const raw = lines[i]!.replace(/\/\/.*$/, '').trim();
      if (!raw || raw.startsWith('@@')) continue;
      const m = /^(\w+)\s+(\w+)(\[\])?(\?)?(.*)$/.exec(raw);
      if (!m) continue;
      const [, name, base, list, opt, rest] = m;
      const type = `${base}${list ?? ''}${opt ?? ''}`;
      const f: PrismaField = { name: name!, type, line: i + 1 };
      if (modelNames.has(base!) && !SCALARS.has(base!)) {
        f.target = base!;
        const rel = /@relation\(([^)]*)\)/.exec(rest ?? '')?.[1];
        const fk = rel && /fields:\s*\[([^\]]*)\]/.exec(rel)?.[1];
        f.relation = list ? 'many' : fk ? `one (fk: ${fk.replace(/\s+/g, '')})` : 'one';
      }
      fields.push(f);
    }
    models.push({ name: b.name, line: b.start + 1, endLine: b.end + 1, fields, ...(b.doc ? { doc: b.doc } : {}) });
  }
  return models;
}
