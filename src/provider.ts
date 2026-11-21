import * as vscode from 'vscode';
import { randomUUID } from 'node:crypto';
import { ApiError, ApiMessage, listModels, streamChat } from './api';
import {
  getApiKey,
  getSettings,
  getStoredModel,
  SECRET_KEY,
  setApiKey,
  setStoredModel,
  Settings,
} from './config';
import {
  ChatMessage,
  ContextItem,
  ExtToUi,
  MessageMeta,
  ModelInfo,
  UiState,
  UiToExt,
} from './protocol';

const MODELS_CACHE_KEY = 'omnillm.modelsCache';
const MESSAGES_KEY = 'omnillm.messages';
const MODELS_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_CONTEXT_ITEM_CHARS = 40000;

interface ModelsCache {
  baseUrl: string;
  query: string;
  fetchedAt: number;
  models: ModelInfo[];
}

function newId(): string {
  return randomUUID();
}

function maskKey(key: string): string {
  return key.length <= 4 ? '••••' : `••••${key.slice(-4)}`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    return error.message;
  }
  if (error instanceof Error) {
    if (error.name === 'AbortError') {
      return 'Запрос отменён.';
    }
    const cause = (error as { cause?: { code?: unknown } }).cause;
    if (cause?.code === 'ENOTFOUND' || cause?.code === 'ECONNREFUSED') {
      return 'Не удалось подключиться к API. Проверь base URL и сеть.';
    }
    return error.message;
  }
  return String(error);
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = 'omnillm.chat';

  private view?: vscode.WebviewView;
  private viewReady = false;
  private messages: ChatMessage[];
  private contextItems: ContextItem[] = [];
  private models: ModelInfo[] = [];
  private modelsUpdatedAt?: number;
  private modelsLoading = false;
  private modelsError?: string;
  private busy = false;
  private abortController?: AbortController;
  private outbox: ExtToUi[] = [];

  constructor(private readonly context: vscode.ExtensionContext) {
    this.messages = context.workspaceState.get<ChatMessage[]>(MESSAGES_KEY, []);
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    this.viewReady = false;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, 'dist'),
        vscode.Uri.joinPath(this.context.extensionUri, 'media'),
      ],
    };
    view.webview.html = this.getHtml(view.webview);
    view.webview.onDidReceiveMessage((message: UiToExt) => {
      void this.handleMessage(message);
    });
    view.onDidDispose(() => {
      this.view = undefined;
      this.viewReady = false;
    });
  }

  async warmUp(): Promise<void> {
    const key = await getApiKey(this.context);
    if (!key && this.needsKey(getSettings())) {
      return;
    }
    await this.refreshModels(false);
  }

  async configurationChanged(): Promise<void> {
    this.models = [];
    this.modelsUpdatedAt = undefined;
    this.post({ type: 'models', models: [], loading: false });
    await this.refreshModels(true);
  }

  async open(): Promise<void> {
    await vscode.commands.executeCommand('omnillm.chat.focus');
  }

  newChat(): void {
    this.abortController?.abort();
    this.messages = [];
    this.contextItems = [];
    void this.persist();
    this.post({ type: 'history', messages: [] });
    this.post({ type: 'context', items: [] });
    this.notice('Начат новый чат');
  }

  addSelection(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('OmniLLM: нет активного редактора.');
      return;
    }
    const document = editor.document;
    const selection = editor.selection;
    const text = selection.isEmpty ? document.getText() : document.getText(selection);
    if (!text.trim()) {
      void vscode.window.showWarningMessage('OmniLLM: нечего добавлять — текст пустой.');
      return;
    }
    const startLine = selection.isEmpty ? 0 : selection.start.line;
    const endLine = selection.isEmpty
      ? Math.max(document.lineCount - 1, 0)
      : selection.end.line;
    const label = `${vscode.workspace.asRelativePath(document.uri, false)}#L${
      startLine + 1
    }-${endLine + 1}`;
    this.pushContext({
      kind: selection.isEmpty ? 'file' : 'selection',
      label,
      text,
      path: document.uri.fsPath,
    });
  }

  addFile(): void {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      void vscode.window.showWarningMessage('OmniLLM: нет активного редактора.');
      return;
    }
    const document = editor.document;
    const text = document.getText();
    if (!text.trim()) {
      void vscode.window.showWarningMessage('OmniLLM: файл пустой.');
      return;
    }
    this.pushContext({
      kind: 'file',
      label: vscode.workspace.asRelativePath(document.uri, false),
      text,
      path: document.uri.fsPath,
    });
  }

  async refreshModels(force: boolean): Promise<void> {
    if (this.modelsLoading) {
      return;
    }
    const settings = getSettings();
    const query = settings.modelsQuery;

    if (!force) {
      const cache = this.context.globalState.get<ModelsCache>(MODELS_CACHE_KEY);
      const fresh =
        cache &&
        cache.baseUrl === settings.baseUrl &&
        cache.query === query &&
        Date.now() - cache.fetchedAt < MODELS_TTL_MS;
      if (cache && cache.baseUrl === settings.baseUrl) {
        this.models = cache.models;
        this.modelsUpdatedAt = cache.fetchedAt;
        this.post({
          type: 'models',
          models: this.models,
          updatedAt: this.modelsUpdatedAt,
          loading: false,
        });
      }
      if (fresh) {
        return;
      }
    }

    this.modelsLoading = true;
    this.post({
      type: 'models',
      models: this.models,
      updatedAt: this.modelsUpdatedAt,
      loading: true,
    });

    try {
      const key = await getApiKey(this.context);
      const models = await listModels(settings, key);
      this.models = models;
      this.modelsUpdatedAt = Date.now();
      this.modelsError = undefined;
      const cache: ModelsCache = {
        baseUrl: settings.baseUrl,
        query,
        fetchedAt: this.modelsUpdatedAt,
        models,
      };
      await this.context.globalState.update(MODELS_CACHE_KEY, cache);
      this.post({
        type: 'models',
        models,
        updatedAt: this.modelsUpdatedAt,
        loading: false,
      });
    } catch (error) {
      this.modelsError = toErrorMessage(error);
      this.post({
        type: 'models',
        models: this.models,
        updatedAt: this.modelsUpdatedAt,
        error: this.modelsError,
        loading: false,
      });
    } finally {
      this.modelsLoading = false;
    }
  }

  async promptForApiKey(): Promise<void> {
    const existing = await getApiKey(this.context);
    const value = await vscode.window.showInputBox({
      title: 'OmniLLM: API-ключ',
      prompt:
        'Ключ хранится в защищённом хранилище VS Code и не попадает в settings.json.',
      password: true,
      ignoreFocusOut: true,
      placeHolder: existing ? 'Ключ задан — введи новый, чтобы заменить' : 'Вставь API-ключ',
    });
    if (value === undefined) {
      return;
    }
    const trimmed = value.trim();
    if (!trimmed) {
      this.notice('Пустой ключ — ничего не сохранено', 'warn');
      return;
    }
    try {
      await setApiKey(this.context, trimmed);
      // Проверяем, что запись реально прошла (на Linux без keyring секреты
      // могут быть недоступны — тогда честно сообщаем об этом).
      const stored = await getApiKey(this.context);
      if (!stored || stored !== trimmed) {
        const message =
          'Не удалось сохранить ключ: хранилище секретов VS Code недоступно. ' +
          'Проверь, что в системе есть keyring (gnome-keyring или KWallet).';
        this.notice(message, 'error');
        void vscode.window.showErrorMessage(`OmniLLM: ${message}`);
        return;
      }
      const hint = maskKey(stored);
      this.post({ type: 'auth', keySet: true, hint });
      this.notice(`API-ключ сохранён (${hint})`);
      await this.refreshModels(true);
    } catch (error) {
      const message = `Не удалось сохранить ключ: ${toErrorMessage(error)}`;
      this.notice(message, 'error');
      void vscode.window.showErrorMessage(`OmniLLM: ${message}`);
    }
  }

  async keyStatus(): Promise<void> {
    const key = await getApiKey(this.context);
    if (!key) {
      const choice = await vscode.window.showInformationMessage(
        'OmniLLM: API-ключ не задан.',
        'Задать ключ',
      );
      if (choice === 'Задать ключ') {
        await this.promptForApiKey();
      }
      return;
    }
    void vscode.window.showInformationMessage(
      `OmniLLM: ключ сохранён (${maskKey(key)}), длина ${key.length} символов.`,
    );
  }

  async clearApiKey(): Promise<void> {
    await this.context.secrets.delete(SECRET_KEY);
    this.post({ type: 'auth', keySet: false });
    this.notice('API-ключ удалён');
  }

  private async handleMessage(message: UiToExt): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.viewReady = true;
        this.flush();
        await this.sendInit();
        break;
      case 'send':
        await this.onSend(message.text);
        break;
      case 'stop':
        this.abortController?.abort();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'selectModel':
        await this.selectModel(message.id);
        break;
      case 'refreshModels':
        await this.refreshModels(true);
        break;
      case 'setApiKey':
        await this.promptForApiKey();
        break;
      case 'insertCode':
        await this.insertCode(message.code);
        break;
      case 'copyCode':
        await vscode.env.clipboard.writeText(message.code);
        this.notice('Код скопирован в буфер обмена');
        break;
      case 'openLink':
        if (/^https?:\/\//i.test(message.url)) {
          await vscode.env.openExternal(vscode.Uri.parse(message.url));
        }
        break;
      case 'addSelection':
        this.addSelection();
        break;
      case 'addFile':
        this.addFile();
        break;
      case 'removeContext':
        this.removeContext(message.id);
        break;
      default:
        break;
    }
  }

  private async sendInit(): Promise<void> {
    const settings = getSettings();
    const key = await getApiKey(this.context);
    const state: UiState = {
      model: this.currentModel(),
      keySet: Boolean(key) || !this.needsKey(settings),
      baseUrl: settings.baseUrl,
      busy: this.busy,
      messages: this.messages,
      context: this.contextItems,
    };
    this.post({
      type: 'init',
      state,
      models: this.models,
      modelsUpdatedAt: this.modelsUpdatedAt,
      modelsLoading: this.modelsLoading,
      modelsError: this.modelsError,
    });
    if ((key || !this.needsKey(settings)) && !this.models.length && !this.modelsLoading) {
      void this.refreshModels(false);
    }
  }

  private needsKey(settings: Settings): boolean {
    try {
      const host = new URL(settings.baseUrl).hostname.toLowerCase();
      return ![
        'localhost',
        '127.0.0.1',
        '::1',
        '0.0.0.0',
        'host.docker.internal',
      ].includes(host);
    } catch {
      return true;
    }
  }

  private currentModel(): string {
    return getStoredModel(this.context) ?? getSettings().model;
  }

  private async selectModel(id: string): Promise<void> {
    await setStoredModel(this.context, id);
    this.post({ type: 'model', id });
    this.notice(`Модель: ${id}`);
  }

  private async onSend(raw: string): Promise<void> {
    const text = raw.trim();
    if (!text || this.busy) {
      return;
    }
    const settings = getSettings();
    const model = this.currentModel();
    const key = await getApiKey(this.context);

    const contextBlock = this.buildContextBlock();
    const apiUserContent = contextBlock ? `${contextBlock}\n\n${text}` : text;

    this.messages.push({ id: newId(), role: 'user', content: text });
    this.contextItems = [];
    this.post({ type: 'history', messages: this.messages });
    this.post({ type: 'context', items: [] });
    await this.persist();

    const apiMessages = this.buildApiMessages(settings, apiUserContent);

    this.busy = true;
    this.post({ type: 'busy', value: true });

    const controller = new AbortController();
    this.abortController = controller;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, settings.requestTimeoutMs);

    let assistantText = '';
    try {
      const result = await streamChat({
        settings,
        key,
        model,
        messages: apiMessages,
        signal: controller.signal,
        onDelta: (delta) => {
          assistantText += delta;
          this.post({ type: 'chunk', text: delta });
        },
      });

      const meta: MessageMeta = {
        model: result.model ?? model,
        provider: result.provider,
        usage: result.usage,
      };
      if (assistantText) {
        this.messages.push({
          id: newId(),
          role: 'assistant',
          content: assistantText,
          meta,
        });
        await this.persist();
        this.post({ type: 'done', meta });
      } else {
        this.post({ type: 'error', message: 'Модель вернула пустой ответ.' });
      }
    } catch (error) {
      const abortedByUser = controller.signal.aborted && !timedOut;
      if (abortedByUser) {
        if (assistantText) {
          const meta: MessageMeta = { model, stopped: true };
          this.messages.push({
            id: newId(),
            role: 'assistant',
            content: assistantText,
            meta,
          });
          await this.persist();
          this.post({ type: 'done', meta });
        } else {
          this.post({ type: 'done' });
        }
      } else {
        if (assistantText) {
          this.messages.push({
            id: newId(),
            role: 'assistant',
            content: assistantText,
            meta: { model, error: true },
          });
          await this.persist();
          this.post({ type: 'done', meta: { model, error: true } });
        }
        const message = timedOut
          ? `Запрос превысил таймаут (${Math.round(
              settings.requestTimeoutMs / 1000,
            )} с).`
          : toErrorMessage(error);
        this.post({ type: 'error', message });
      }
    } finally {
      clearTimeout(timer);
      this.abortController = undefined;
      this.busy = false;
      this.post({ type: 'busy', value: false });
    }
  }

  private buildContextBlock(): string {
    if (!this.contextItems.length) {
      return '';
    }
    const parts = this.contextItems.map(
      (item) => `--- ${item.label} ---\n${item.text}`,
    );
    return `Контекст из редактора:\n\n${parts.join('\n\n')}`;
  }

  private buildApiMessages(settings: Settings, userContent: string): ApiMessage[] {
    const result: ApiMessage[] = [];
    const systemPrompt = settings.systemPrompt.trim();
    if (systemPrompt) {
      result.push({ role: 'system', content: systemPrompt });
    }

    const history = this.messages
      .filter((message) => !message.meta?.error)
      .slice(0, -1)
      .map((message) => ({ role: message.role, content: message.content }));

    let total = systemPrompt.length + userContent.length;
    const kept: ApiMessage[] = [];
    for (let index = history.length - 1; index >= 0; index -= 1) {
      const message = history[index];
      total += message.content.length;
      if (total > settings.maxContextChars) {
        break;
      }
      kept.unshift(message);
    }

    return [...result, ...kept, { role: 'user', content: userContent }];
  }

  private pushContext(item: Omit<ContextItem, 'id'>): void {
    const text =
      item.text.length > MAX_CONTEXT_ITEM_CHARS
        ? `${item.text.slice(0, MAX_CONTEXT_ITEM_CHARS)}\n… (обрезано)`
        : item.text;
    const duplicate = this.contextItems.find(
      (existing) => existing.label === item.label,
    );
    if (duplicate) {
      duplicate.text = text;
    } else {
      this.contextItems.push({ ...item, text, id: newId() });
    }
    this.post({ type: 'context', items: this.contextItems });
    this.notice(`Добавлено в контекст: ${item.label}`);
  }

  private removeContext(id: string): void {
    this.contextItems = this.contextItems.filter((item) => item.id !== id);
    this.post({ type: 'context', items: this.contextItems });
  }

  private async insertCode(code: string): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      await vscode.env.clipboard.writeText(code);
      this.notice('Нет активного редактора — код скопирован в буфер', 'warn');
      return;
    }
    const inserted = await editor.edit((builder) =>
      builder.insert(editor.selection.active, code),
    );
    if (inserted) {
      this.notice('Код вставлен в редактор');
    }
  }

  private async persist(): Promise<void> {
    await this.context.workspaceState.update(MESSAGES_KEY, this.messages);
  }

  private notice(message: string, kind: 'info' | 'warn' | 'error' = 'info'): void {
    this.post({ type: 'notice', message, kind });
  }

  private post(message: ExtToUi): void {
    if (this.view && this.viewReady) {
      void this.view.webview.postMessage(message);
    } else {
      this.outbox.push(message);
    }
  }

  private flush(): void {
    if (!this.view || !this.viewReady) {
      return;
    }
    const pending = this.outbox.splice(0);
    for (const message of pending) {
      void this.view.webview.postMessage(message);
    }
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomUUID().replace(/-/g, '');
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'webview.js'),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, 'media', 'style.css'),
    );
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <link rel="stylesheet" href="${styleUri}" />
  <title>OmniLLM</title>
</head>
<body>
  <div id="app">
    <header class="topbar">
      <button id="model-btn" class="model-btn" title="Выбрать модель">
        <span id="model-label">Модель</span>
        <span class="chev">▾</span>
      </button>
      <div class="top-actions">
        <button id="new-btn" class="icon-btn" title="Новый чат">+</button>
        <button id="key-btn" class="icon-btn" title="API-ключ">⚿</button>
      </div>
    </header>

    <div id="banner" class="banner hidden"></div>
    <div id="context-bar" class="context-bar hidden"></div>

    <main id="messages" class="messages"></main>

    <footer class="composer">
      <div id="status" class="status hidden"></div>
      <textarea id="input" rows="3" placeholder="Спроси что-нибудь…"></textarea>
      <div class="composer-actions">
        <button id="ctx-btn" class="ghost-btn" title="Добавить выделение в контекст">+ Контекст</button>
        <span class="spacer"></span>
        <button id="send-btn" class="send-btn" disabled>Отправить</button>
      </div>
    </footer>

    <div id="picker" class="picker hidden">
      <div class="picker-head">
        <input id="model-search" type="text" placeholder="Поиск модели…" />
        <button id="refresh-btn" class="icon-btn" title="Обновить список">⟳</button>
        <button id="picker-close" class="icon-btn" title="Закрыть">✕</button>
      </div>
      <div id="filters" class="filters">
        <button class="chip" data-filter="tools">tools</button>
        <button class="chip" data-filter="vision">vision</button>
        <button class="chip" data-filter="reasoning">reasoning</button>
      </div>
      <div id="model-list" class="model-list"></div>
      <div id="picker-foot" class="picker-foot"></div>
    </div>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}
