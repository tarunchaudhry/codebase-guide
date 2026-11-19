import { join } from 'node:path';
import { OUTPUT_DIR, readJsonFile } from './files.ts';

/** `<repo>/.codebase-guide/config.json`. Every field is optional. */
export interface GuideConfig {
  include?: string[];
  exclude?: string[];
  apiClients?: string[];
  baseUrls?: string[];
  djangoSettings?: string;
  pythonPath?: string[];
  python?: string;
  depth?: 'quick' | 'standard' | 'deep';
  maxFlows?: number;
  flows?: string[];
  audience?: string;
  customConventions?: string;
  budget?: { maxFileReads?: number; confirmAboveTokens?: number };
  snippets?: boolean;
  editorScheme?: 'vscode' | 'cursor' | 'idea';
}

export function loadConfig(root: string): { config: GuideConfig; warnings: string[] } {
  const path = join(root, OUTPUT_DIR, 'config.json');
  const raw = readJsonFile<unknown>(path);
  if (raw === undefined) return { config: {}, warnings: [] };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { config: {}, warnings: [`${OUTPUT_DIR}/config.json is not a JSON object; ignored`] };
  const strArr = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  const checks: Record<string, (v: unknown) => boolean> = {
    include: strArr, exclude: strArr, apiClients: strArr, baseUrls: strArr, pythonPath: strArr, flows: strArr,
    djangoSettings: (v) => typeof v === 'string', python: (v) => typeof v === 'string',
    audience: (v) => typeof v === 'string', customConventions: (v) => typeof v === 'string',
    depth: (v) => v === 'quick' || v === 'standard' || v === 'deep',
    maxFlows: (v) => Number.isInteger(v) && (v as number) > 0,
    budget: (v) => !!v && typeof v === 'object',
    snippets: (v) => typeof v === 'boolean',
    editorScheme: (v) => v === 'vscode' || v === 'cursor' || v === 'idea',
  };
  const config: Record<string, unknown> = {};
  const warnings: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    const check = checks[k];
    if (!check) warnings.push(`config.json: unknown key "${k}" ignored`);
    else if (!check(v)) warnings.push(`config.json: invalid value for "${k}" ignored`);
    else config[k] = v;
  }
  return { config: config as GuideConfig, warnings };
}
