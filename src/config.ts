import * as vscode from 'vscode';

export const SECRET_KEY = 'omnillm.apiKey';
export const MODEL_STATE_KEY = 'omnillm.selectedModel';

export interface Settings {
  baseUrl: string;
  modelsQuery: string;
  model: string;
  systemPrompt: string;
  temperature: number;
  maxTokens: number;
  maxContextChars: number;
  requestTimeoutMs: number;
  streamUsage: boolean;
}

const DEFAULT_SYSTEM_PROMPT =
  'Ты — полезный ассистент по программированию. Отвечай по-русски, кратко и по делу. ' +
  'Код оформляй в markdown-блоках с указанием языка.';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Приводит base URL к виду `https://host/path/v1`.
 * Уже существующий суффикс версии (`/v1`, `/api/v1`, ...) не дублируется.
 */
export function normalizeBaseUrl(raw: string): string {
  let url = (raw ?? '').trim().replace(/\/+$/, '');
  if (!url) {
    url = 'https://polza.ai/api/v1';
  }
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`;
  }
  if (!/\/v\d+$/i.test(url)) {
    url += '/v1';
  }
  return url;
}

export function getSettings(): Settings {
  const config = vscode.workspace.getConfiguration('omnillm');
  return {
    baseUrl: normalizeBaseUrl(config.get<string>('baseUrl', 'https://polza.ai/api/v1')),
    modelsQuery: (config.get<string>('modelsQuery', 'type=chat') ?? '').trim(),
    model: (config.get<string>('model', 'openai/gpt-4o') ?? '').trim(),
    systemPrompt: config.get<string>('systemPrompt', DEFAULT_SYSTEM_PROMPT) ?? '',
    temperature: clamp(config.get<number>('temperature', 0.7), 0, 2),
    maxTokens: Math.max(1, Math.round(config.get<number>('maxTokens', 4096))),
    maxContextChars: Math.max(2000, Math.round(config.get<number>('maxContextChars', 24000))),
    requestTimeoutMs: Math.max(5000, Math.round(config.get<number>('requestTimeoutMs', 180000))),
    streamUsage: config.get<boolean>('streamUsage', true),
  };
}

export async function getApiKey(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = await context.secrets.get(SECRET_KEY);
  return key && key.trim() ? key.trim() : undefined;
}

export async function setApiKey(context: vscode.ExtensionContext, key: string): Promise<void> {
  await context.secrets.store(SECRET_KEY, key);
}

export function getStoredModel(context: vscode.ExtensionContext): string | undefined {
  return context.globalState.get<string>(MODEL_STATE_KEY);
}

export async function setStoredModel(context: vscode.ExtensionContext, model: string): Promise<void> {
  await context.globalState.update(MODEL_STATE_KEY, model);
}
