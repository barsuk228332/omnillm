import type { ModelInfo, Usage } from './protocol';
import type { Settings } from './config';

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface StreamResult {
  usage?: Usage;
  provider?: string;
  model?: string;
  finishReason?: string;
}

export interface StreamOptions {
  settings: Settings;
  key?: string;
  model: string;
  messages: ApiMessage[];
  signal: AbortSignal;
  onDelta: (text: string) => void;
}

function headers(key?: string): Record<string, string> {
  const result: Record<string, string> = { 'Content-Type': 'application/json' };
  if (key) {
    result.Authorization = `Bearer ${key}`;
  }
  return result;
}

async function describeError(response: Response): Promise<string> {
  let detail = '';
  try {
    const text = await response.text();
    try {
      const parsed = JSON.parse(text) as {
        error?: { message?: string } | string;
        message?: string;
      };
      const raw =
        typeof parsed.error === 'string'
          ? parsed.error
          : parsed.error?.message ?? parsed.message ?? text;
      detail = typeof raw === 'string' ? raw : JSON.stringify(raw);
    } catch {
      detail = text;
    }
  } catch {
    // тело ответа недоступно — обойдёмся статусом
  }
  detail = detail.trim().slice(0, 400);
  const suffix = detail ? ` Детали: ${detail}` : '';
  switch (response.status) {
    case 400:
      return `Некорректный запрос (400).${suffix}`;
    case 401:
      return `Неверный или отозванный API-ключ (401).${suffix}`;
    case 402:
      return `Недостаточно средств на балансе (402).${suffix}`;
    case 403:
      return `Доступ запрещён (403).${suffix}`;
    case 404:
      return `Эндпоинт не найден (404) — проверь base URL.${suffix}`;
    case 408:
      return 'Сервер не ответил вовремя (408).';
    case 429:
      return `Слишком много запросов (429). Попробуй позже.${suffix}`;
    default:
      if (response.status >= 500) {
        return `Ошибка на стороне провайдера (${response.status}).${suffix}`;
      }
      return `Ошибка API (${response.status}).${suffix}`;
  }
}

export function modelsUrl(settings: Settings): string {
  const query = (settings.modelsQuery || '').trim();
  if (!query) {
    return `${settings.baseUrl}/models`;
  }
  return `${settings.baseUrl}/models${query.startsWith('?') ? query : `?${query}`}`;
}

function toNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

interface RawModel {
  id?: unknown;
  name?: unknown;
  short_description?: unknown;
  architecture?: { input_modalities?: unknown };
  top_provider?: {
    context_length?: unknown;
    max_completion_tokens?: unknown;
    supported_parameters?: unknown;
    pricing?: Record<string, unknown>;
    capabilities?: Record<string, { status?: unknown }>;
  };
}

function toModelInfo(raw: RawModel): ModelInfo | undefined {
  if (typeof raw?.id !== 'string' || !raw.id) {
    return undefined;
  }
  const provider = raw.top_provider ?? {};
  const pricing = provider.pricing ?? {};
  const capabilities = provider.capabilities ?? {};
  const parameters = Array.isArray(provider.supported_parameters)
    ? provider.supported_parameters.filter((item): item is string => typeof item === 'string')
    : undefined;
  const modalities = Array.isArray(raw.architecture?.input_modalities)
    ? raw.architecture.input_modalities.filter((item): item is string => typeof item === 'string')
    : undefined;

  const capabilitySupported = (name: string): boolean => capabilities[name]?.status === 'supported';
  const hasParameter = (name: string): boolean => Boolean(parameters?.includes(name));

  return {
    id: raw.id,
    name: typeof raw.name === 'string' ? raw.name : undefined,
    description: typeof raw.short_description === 'string' ? raw.short_description : undefined,
    contextLength: toNumber(provider.context_length),
    maxCompletion: toNumber(provider.max_completion_tokens),
    promptPrice: toNumber(pricing.prompt_per_million),
    completionPrice: toNumber(pricing.completion_per_million),
    currency: typeof pricing.currency === 'string' ? pricing.currency : undefined,
    inputModalities: modalities,
    supportedParameters: parameters,
    supportsTools: capabilitySupported('tools') || hasParameter('tools'),
    supportsVision: Boolean(modalities?.includes('image')),
    supportsReasoning: capabilitySupported('reasoning_effort') || hasParameter('reasoning_effort'),
  };
}

export async function listModels(
  settings: Settings,
  key: string | undefined,
  signal?: AbortSignal,
): Promise<ModelInfo[]> {
  const response = await fetch(modelsUrl(settings), {
    method: 'GET',
    headers: headers(key),
    signal,
  });
  if (!response.ok) {
    throw new ApiError(await describeError(response), response.status);
  }
  const payload = (await response.json()) as { data?: RawModel[] };
  const data = Array.isArray(payload?.data) ? payload.data : [];
  return data
    .map(toModelInfo)
    .filter((model): model is ModelInfo => Boolean(model))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function extractDelta(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') {
          return part;
        }
        if (part && typeof part === 'object' && 'text' in part) {
          return String((part as { text?: unknown }).text ?? '');
        }
        return '';
      })
      .join('');
  }
  return '';
}

export async function streamChat(options: StreamOptions): Promise<StreamResult> {
  const { settings, key, model, messages, signal, onDelta } = options;
  const response = await fetch(`${settings.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: headers(key),
    signal,
    body: JSON.stringify({
      model,
      messages,
      temperature: settings.temperature,
      max_tokens: settings.maxTokens,
      stream: true,
      ...(settings.streamUsage ? { stream_options: { include_usage: true } } : {}),
    }),
  });

  if (!response.ok) {
    throw new ApiError(await describeError(response), response.status);
  }
  if (!response.body) {
    throw new ApiError('Сервер вернул пустой ответ.');
  }

  const result: StreamResult = {};
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const separator = /\r?\n\r?\n/;

  const handlePayload = (payload: string): void => {
    const trimmed = payload.trim();
    if (!trimmed || trimmed === '[DONE]') {
      return;
    }
    let chunk: {
      provider?: unknown;
      model?: unknown;
      usage?: unknown;
      choices?: Array<{
        finish_reason?: unknown;
        delta?: { content?: unknown };
      }>;
    };
    try {
      chunk = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (typeof chunk.provider === 'string') {
      result.provider = chunk.provider;
    }
    if (typeof chunk.model === 'string') {
      result.model = chunk.model;
    }
    if (chunk.usage && typeof chunk.usage === 'object') {
      result.usage = chunk.usage as Usage;
    }
    const choice = chunk.choices?.[0];
    if (typeof choice?.finish_reason === 'string') {
      result.finishReason = choice.finish_reason;
    }
    const delta = extractDelta(choice?.delta?.content);
    if (delta) {
      onDelta(delta);
    }
  };

  const handleEvent = (raw: string): void => {
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith(':')) {
        continue;
      }
      if (!trimmed.startsWith('data:')) {
        continue;
      }
      handlePayload(trimmed.slice(5));
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    let match = separator.exec(buffer);
    while (match) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      handleEvent(raw);
      match = separator.exec(buffer);
    }
  }
  buffer += decoder.decode();
  if (buffer.trim()) {
    handleEvent(buffer);
  }

  return result;
}
