export type ChatRole = 'user' | 'assistant';

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  cost_rub?: number;
  cost?: number;
}

export interface MessageMeta {
  model?: string;
  provider?: string;
  usage?: Usage;
  stopped?: boolean;
  error?: boolean;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  meta?: MessageMeta;
}

export interface ContextItem {
  id: string;
  kind: 'selection' | 'file';
  label: string;
  text: string;
  path?: string;
}

export interface ModelInfo {
  id: string;
  name?: string;
  description?: string;
  contextLength?: number;
  maxCompletion?: number;
  promptPrice?: number;
  completionPrice?: number;
  currency?: string;
  inputModalities?: string[];
  supportedParameters?: string[];
  supportsTools?: boolean;
  supportsVision?: boolean;
  supportsReasoning?: boolean;
}

export interface UiState {
  model: string;
  keySet: boolean;
  baseUrl: string;
  busy: boolean;
  messages: ChatMessage[];
  context: ContextItem[];
}

export type UiToExt =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'selectModel'; id: string }
  | { type: 'refreshModels' }
  | { type: 'setApiKey' }
  | { type: 'insertCode'; code: string }
  | { type: 'copyCode'; code: string }
  | { type: 'openLink'; url: string }
  | { type: 'addSelection' }
  | { type: 'addFile' }
  | { type: 'removeContext'; id: string };

export type ExtToUi =
  | {
      type: 'init';
      state: UiState;
      models: ModelInfo[];
      modelsUpdatedAt?: number;
      modelsLoading?: boolean;
      modelsError?: string;
    }
  | { type: 'history'; messages: ChatMessage[] }
  | { type: 'context'; items: ContextItem[] }
  | {
      type: 'models';
      models: ModelInfo[];
      updatedAt?: number;
      error?: string;
      loading: boolean;
    }
  | { type: 'model'; id: string }
  | { type: 'chunk'; text: string }
  | { type: 'done'; meta?: MessageMeta }
  | { type: 'busy'; value: boolean }
  | { type: 'auth'; keySet: boolean; hint?: string }
  | { type: 'error'; message: string }
  | { type: 'notice'; message: string; kind?: 'info' | 'warn' | 'error' };
