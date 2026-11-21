import { marked } from 'marked';
import DOMPurify from 'dompurify';
import hljs from 'highlight.js/lib/common';
import type {
  ChatMessage,
  ContextItem,
  ExtToUi,
  MessageMeta,
  ModelInfo,
  UiState,
  UiToExt,
} from '../protocol';

declare function acquireVsCodeApi(): {
  postMessage(message: UiToExt): void;
};

const vscode = acquireVsCodeApi();

marked.setOptions({ gfm: true, breaks: true });

function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) {
    throw new Error(`Не найден элемент #${id}`);
  }
  return node as T;
}

const messagesEl = byId<HTMLElement>('messages');
const inputEl = byId<HTMLTextAreaElement>('input');
const sendBtn = byId<HTMLButtonElement>('send-btn');
const modelBtn = byId<HTMLButtonElement>('model-btn');
const modelLabel = byId<HTMLElement>('model-label');
const pickerEl = byId<HTMLElement>('picker');
const modelListEl = byId<HTMLElement>('model-list');
const searchEl = byId<HTMLInputElement>('model-search');
const pickerFootEl = byId<HTMLElement>('picker-foot');
const refreshBtn = byId<HTMLButtonElement>('refresh-btn');
const bannerEl = byId<HTMLElement>('banner');
const contextBarEl = byId<HTMLElement>('context-bar');
const statusEl = byId<HTMLElement>('status');
const keyBtn = byId<HTMLButtonElement>('key-btn');

let state: UiState = {
  model: '',
  keySet: false,
  baseUrl: '',
  busy: false,
  messages: [],
  context: [],
};
let models: ModelInfo[] = [];
let modelsUpdatedAt: number | undefined;
let modelsLoading = false;
let modelsError: string | undefined;
const activeFilters = new Set<string>();
let searchQuery = '';

let streamingEl: HTMLElement | null = null;
let streamingText = '';
let renderTimer = 0;
let statusTimer = 0;

function post(message: UiToExt): void {
  vscode.postMessage(message);
}

/* ---------- Markdown ---------- */

function renderMarkdown(text: string): string {
  const html = marked.parse(text, { async: false }) as string;
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

function enhanceCodeBlocks(root: HTMLElement): void {
  root.querySelectorAll('pre > code').forEach((node) => {
    const code = node as HTMLElement;
    try {
      hljs.highlightElement(code);
    } catch {
      /* ignore */
    }
    const pre = code.parentElement;
    if (!pre || pre.parentElement?.classList.contains('codeblock')) {
      return;
    }
    const language = (code.className.match(/language-([\w-]+)/)?.[1] ?? '').trim();
    const block = document.createElement('div');
    block.className = 'codeblock';

    const head = document.createElement('div');
    head.className = 'codeblock-head';
    const lang = document.createElement('span');
    lang.className = 'codeblock-lang';
    lang.textContent = language || 'code';
    head.appendChild(lang);

    const actions = document.createElement('div');
    actions.className = 'codeblock-actions';
    const copyBtn = document.createElement('button');
    copyBtn.dataset.action = 'copy';
    copyBtn.textContent = 'Копировать';
    const insertBtn = document.createElement('button');
    insertBtn.dataset.action = 'insert';
    insertBtn.textContent = 'Вставить';
    actions.append(copyBtn, insertBtn);
    head.appendChild(actions);

    pre.replaceWith(block);
    block.append(head, pre);
  });
}

/* ---------- Сообщения ---------- */

function formatNumber(value: number): string {
  return new Intl.NumberFormat('ru-RU').format(value);
}

function formatCost(value: number): string {
  return new Intl.NumberFormat('ru-RU', {
    maximumFractionDigits: value < 0.01 ? 4 : 2,
  }).format(value);
}

function metaNode(meta: MessageMeta): HTMLElement {
  const node = document.createElement('div');
  node.className = 'msg-meta';
  const parts: string[] = [];
  if (meta.model) {
    parts.push(meta.model);
  }
  if (meta.provider) {
    parts.push(meta.provider);
  }
  if (meta.usage) {
    const prompt = meta.usage.prompt_tokens ?? 0;
    const completion = meta.usage.completion_tokens ?? 0;
    const total = meta.usage.total_tokens ?? prompt + completion;
    if (total) {
      parts.push(`${formatNumber(prompt)} / ${formatNumber(completion)} tok`);
    }
    const cost = meta.usage.cost_rub ?? meta.usage.cost;
    if (typeof cost === 'number' && Number.isFinite(cost)) {
      parts.push(`${formatCost(cost)} ₽`);
    }
  }
  if (meta.stopped) {
    parts.push('остановлено');
  }
  if (meta.error) {
    parts.push('ошибка');
  }
  node.textContent = parts.join(' · ');
  return node;
}

function renderMessage(message: ChatMessage): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = `msg ${message.role}`;

  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (message.role === 'user') {
    bubble.textContent = message.content;
  } else {
    bubble.classList.add('markdown');
    bubble.innerHTML = renderMarkdown(message.content);
    enhanceCodeBlocks(bubble);
  }
  wrap.appendChild(bubble);

  if (message.meta) {
    wrap.appendChild(metaNode(message.meta));
  }
  return wrap;
}

function renderEmpty(): void {
  messagesEl.innerHTML = '';
  const empty = document.createElement('div');
  empty.className = 'empty';
  empty.innerHTML = `
    <div class="empty-title">OmniLLM</div>
    <div class="empty-text">Спроси что-нибудь или добавь код в контекст.</div>
    <div class="empty-hint">Ctrl+Alt+A — выделение · Ctrl+Alt+F — файл</div>`;
  messagesEl.appendChild(empty);
}

function renderAll(): void {
  streamingEl = null;
  streamingText = '';
  if (!state.messages.length) {
    renderEmpty();
    return;
  }
  messagesEl.innerHTML = '';
  for (const message of state.messages) {
    messagesEl.appendChild(renderMessage(message));
  }
  scrollToBottom(true);
}

function scrollToBottom(force: boolean): void {
  const distance =
    messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
  if (force || distance < 140) {
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }
}

function onChunk(text: string): void {
  if (!streamingEl) {
    streamingEl = document.createElement('div');
    streamingEl.className = 'msg assistant';
    const bubble = document.createElement('div');
    bubble.className = 'bubble markdown streaming';
    streamingEl.appendChild(bubble);
    messagesEl.appendChild(streamingEl);
    if (messagesEl.querySelector('.empty')) {
      messagesEl.innerHTML = '';
      messagesEl.appendChild(streamingEl);
    }
  }
  streamingText += text;
  if (renderTimer) {
    return;
  }
  renderTimer = window.setTimeout(() => {
    renderTimer = 0;
    const bubble = streamingEl?.querySelector('.bubble');
    if (bubble) {
      bubble.innerHTML = renderMarkdown(streamingText);
    }
    scrollToBottom(false);
  }, 60);
}

function finalizeStream(meta?: MessageMeta): void {
  if (renderTimer) {
    window.clearTimeout(renderTimer);
    renderTimer = 0;
  }
  if (streamingEl) {
    const bubble = streamingEl.querySelector('.bubble');
    if (bubble) {
      bubble.classList.remove('streaming');
      bubble.innerHTML = renderMarkdown(streamingText);
      enhanceCodeBlocks(bubble as HTMLElement);
    }
    if (meta) {
      streamingEl.appendChild(metaNode(meta));
    }
    scrollToBottom(true);
  }
  streamingEl = null;
  streamingText = '';
}

function showError(message: string): void {
  finalizeStream();
  const wrap = document.createElement('div');
  wrap.className = 'msg assistant';
  const bubble = document.createElement('div');
  bubble.className = 'bubble error-bubble';
  bubble.textContent = message;
  wrap.appendChild(bubble);
  messagesEl.appendChild(wrap);
  scrollToBottom(true);
}

/* ---------- Контекст ---------- */

function renderContext(): void {
  contextBarEl.innerHTML = '';
  if (!state.context.length) {
    contextBarEl.classList.add('hidden');
    return;
  }
  contextBarEl.classList.remove('hidden');
  for (const item of state.context) {
    contextBarEl.appendChild(contextChip(item));
  }
}

function contextChip(item: ContextItem): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'ctx-chip';
  const label = document.createElement('span');
  label.className = 'ctx-label';
  label.textContent = item.label;
  label.title = item.label;
  const remove = document.createElement('button');
  remove.className = 'ctx-remove';
  remove.textContent = '×';
  remove.title = 'Убрать из контекста';
  remove.addEventListener('click', () => post({ type: 'removeContext', id: item.id }));
  chip.append(label, remove);
  return chip;
}

/* ---------- Пикер моделей ---------- */

function openPicker(): void {
  pickerEl.classList.remove('hidden');
  renderModels();
  searchEl.value = '';
  searchQuery = '';
  searchEl.focus();
}

function closePicker(): void {
  pickerEl.classList.add('hidden');
}

function modelMatches(model: ModelInfo): boolean {
  const query = searchQuery.toLowerCase();
  if (
    query &&
    !model.id.toLowerCase().includes(query) &&
    !(model.name ?? '').toLowerCase().includes(query)
  ) {
    return false;
  }
  if (activeFilters.has('tools') && !model.supportsTools) {
    return false;
  }
  if (activeFilters.has('vision') && !model.supportsVision) {
    return false;
  }
  if (activeFilters.has('reasoning') && !model.supportsReasoning) {
    return false;
  }
  return true;
}

function formatContextLength(value?: number): string | undefined {
  if (!value) {
    return undefined;
  }
  if (value >= 1000) {
    return `${Math.round(value / 1000)}K`;
  }
  return String(value);
}

function modelMetaLine(model: ModelInfo): string {
  const parts: string[] = [];
  const context = formatContextLength(model.contextLength);
  if (context) {
    parts.push(context);
  }
  if (typeof model.promptPrice === 'number' || typeof model.completionPrice === 'number') {
    const prompt = model.promptPrice ?? 0;
    const completion = model.completionPrice ?? 0;
    parts.push(`${formatCost(prompt)}/${formatCost(completion)} ₽`);
  }
  if (model.supportsTools) {
    parts.push('tools');
  }
  if (model.supportsVision) {
    parts.push('vision');
  }
  if (model.supportsReasoning) {
    parts.push('reasoning');
  }
  return parts.join(' · ');
}

function renderModels(): void {
  modelListEl.innerHTML = '';
  const filtered = models.filter(modelMatches);

  if (!filtered.length) {
    const empty = document.createElement('div');
    empty.className = 'picker-empty';
    empty.textContent = models.length
      ? 'Ничего не найдено — измени поиск или фильтры.'
      : 'Список пуст. Нажми ⟳, чтобы загрузить модели.';
    modelListEl.appendChild(empty);
  } else {
    let currentGroup = '';
    for (const model of filtered) {
      const group = model.id.includes('/') ? model.id.split('/')[0] : '';
      if (group && group !== currentGroup) {
        currentGroup = group;
        const header = document.createElement('div');
        header.className = 'model-group';
        header.textContent = group;
        modelListEl.appendChild(header);
      }
      modelListEl.appendChild(modelRow(model));
    }
  }

  refreshBtn.classList.toggle('spinning', modelsLoading);
  refreshBtn.disabled = modelsLoading;

  const footer: string[] = [`${filtered.length} из ${models.length}`];
  if (modelsUpdatedAt) {
    footer.push(`обновлено ${new Date(modelsUpdatedAt).toLocaleString('ru-RU')}`);
  }
  pickerFootEl.textContent = modelsError
    ? `Ошибка: ${modelsError}`
    : footer.join(' · ');
  pickerFootEl.classList.toggle('error-text', Boolean(modelsError));
}

function modelRow(model: ModelInfo): HTMLElement {
  const row = document.createElement('button');
  row.className = 'model-item';
  row.classList.toggle('selected', model.id === state.model);

  const main = document.createElement('div');
  main.className = 'model-main';
  const name = document.createElement('span');
  name.className = 'model-name';
  name.textContent = model.name || model.id;
  const id = document.createElement('span');
  id.className = 'model-id';
  id.textContent = model.id;
  main.append(name, id);

  const meta = document.createElement('div');
  meta.className = 'model-meta';
  meta.textContent = modelMetaLine(model);

  row.append(main, meta);
  row.addEventListener('click', () => {
    post({ type: 'selectModel', id: model.id });
    closePicker();
  });
  return row;
}

/* ---------- Статус и баннер ---------- */

function showStatus(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
  statusEl.textContent = message;
  statusEl.className = `status ${kind}`;
  if (statusTimer) {
    window.clearTimeout(statusTimer);
  }
  statusTimer = window.setTimeout(() => {
    statusEl.classList.add('hidden');
  }, 4000);
}

function renderBanner(): void {
  bannerEl.innerHTML = '';
  if (state.keySet) {
    bannerEl.classList.add('hidden');
    return;
  }
  bannerEl.classList.remove('hidden');
  const text = document.createElement('span');
  text.textContent = 'API-ключ не задан.';
  const button = document.createElement('button');
  button.className = 'link-btn';
  button.textContent = 'Задать ключ';
  button.addEventListener('click', () => post({ type: 'setApiKey' }));
  bannerEl.append(text, button);
}

function updateComposer(): void {
  if (state.busy) {
    sendBtn.textContent = 'Стоп';
    sendBtn.disabled = false;
    sendBtn.classList.add('stop');
  } else {
    sendBtn.textContent = 'Отправить';
    sendBtn.disabled = !inputEl.value.trim();
    sendBtn.classList.remove('stop');
  }
}

function updateModelLabel(): void {
  modelLabel.textContent = state.model || 'Выбрать модель';
  modelBtn.title = state.model || 'Выбрать модель';
}

function updateKeyButton(): void {
  keyBtn.title = state.keySet
    ? 'API-ключ задан — нажми, чтобы заменить'
    : 'API-ключ не задан — нажми, чтобы задать';
  keyBtn.classList.toggle('has-key', state.keySet);
}

/* ---------- Инициализация ---------- */

function render(): void {
  renderAll();
  renderContext();
  renderBanner();
  updateModelLabel();
  updateKeyButton();
  updateComposer();
}

messagesEl.addEventListener('click', (event) => {
  const target = event.target as HTMLElement;
  const actionBtn = target.closest('button[data-action]') as HTMLElement | null;
  if (actionBtn) {
    const block = actionBtn.closest('.codeblock');
    const code = block?.querySelector('pre code')?.textContent ?? '';
    if (actionBtn.dataset.action === 'insert') {
      post({ type: 'insertCode', code });
    } else {
      post({ type: 'copyCode', code });
    }
    return;
  }
  const link = target.closest('a[href]') as HTMLAnchorElement | null;
  if (link && /^https?:\/\//i.test(link.href)) {
    event.preventDefault();
    post({ type: 'openLink', url: link.href });
  }
});

sendBtn.addEventListener('click', () => {
  if (state.busy) {
    post({ type: 'stop' });
    return;
  }
  const text = inputEl.value.trim();
  if (!text) {
    return;
  }
  post({ type: 'send', text });
  inputEl.value = '';
  resizeInput();
  updateComposer();
});

byId('new-btn').addEventListener('click', () => post({ type: 'newChat' }));
keyBtn.addEventListener('click', () => post({ type: 'setApiKey' }));
byId('ctx-btn').addEventListener('click', () => post({ type: 'addSelection' }));
byId('picker-close').addEventListener('click', closePicker);
modelBtn.addEventListener('click', () => {
  if (pickerEl.classList.contains('hidden')) {
    openPicker();
  } else {
    closePicker();
  }
});

refreshBtn.addEventListener('click', () => post({ type: 'refreshModels' }));
searchEl.addEventListener('input', () => {
  searchQuery = searchEl.value;
  renderModels();
});

for (const chip of Array.from(document.querySelectorAll<HTMLElement>('.chip'))) {
  chip.addEventListener('click', () => {
    const filter = chip.dataset.filter;
    if (!filter) {
      return;
    }
    if (activeFilters.has(filter)) {
      activeFilters.delete(filter);
      chip.classList.remove('active');
    } else {
      activeFilters.add(filter);
      chip.classList.add('active');
    }
    renderModels();
  });
}

inputEl.addEventListener('input', () => {
  resizeInput();
  updateComposer();
});

inputEl.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    if (!state.busy) {
      sendBtn.click();
    }
  }
  if (event.key === 'Escape') {
    closePicker();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closePicker();
  }
});

function resizeInput(): void {
  inputEl.style.height = 'auto';
  inputEl.style.height = `${Math.min(inputEl.scrollHeight, 200)}px`;
}

window.addEventListener('message', (event: MessageEvent<ExtToUi>) => {
  const message = event.data;
  switch (message.type) {
    case 'init':
      state = message.state;
      models = message.models ?? [];
      modelsUpdatedAt = message.modelsUpdatedAt;
      modelsLoading = Boolean(message.modelsLoading);
      modelsError = message.modelsError;
      render();
      renderModels();
      if (modelsLoading) {
        showStatus('Загружаю список моделей…');
      }
      break;
    case 'history':
      state.messages = message.messages;
      renderAll();
      break;
    case 'context':
      state.context = message.items;
      renderContext();
      break;
    case 'models':
      models = message.models ?? [];
      modelsUpdatedAt = message.updatedAt;
      modelsLoading = message.loading;
      modelsError = message.error;
      renderModels();
      break;
    case 'model':
      state.model = message.id;
      updateModelLabel();
      renderModels();
      break;
    case 'chunk':
      onChunk(message.text);
      break;
    case 'done':
      finalizeStream(message.meta);
      break;
    case 'busy':
      state.busy = message.value;
      updateComposer();
      if (state.busy) {
        showStatus('Генерация ответа…');
      }
      break;
    case 'auth':
      state.keySet = message.keySet;
      renderBanner();
      updateKeyButton();
      showStatus(
        message.keySet
          ? `API-ключ сохранён${message.hint ? ` (${message.hint})` : ''}`
          : 'API-ключ удалён',
      );
      break;
    case 'error':
      showError(message.message);
      break;
    case 'notice':
      showStatus(message.message, message.kind);
      break;
    default:
      break;
  }
});

renderEmpty();
post({ type: 'ready' });
