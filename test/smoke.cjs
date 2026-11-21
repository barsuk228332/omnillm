/**
 * Интеграционный смоук без VS Code.
 *
 * Подменяет модуль `vscode` стабом, поднимает локальный мок-сервер
 * и прогоняет полный путь расширения: активация → resolve webview →
 * каталог моделей → SSE-стрим → стоимость → история → контекст → ключ.
 */

const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');
const EXTENSION_ENTRY = path.join(ROOT, 'dist', 'extension.js');

if (!fs.existsSync(EXTENSION_ENTRY)) {
  console.error('Нет dist/extension.js — сначала выполни `npm run build`.');
  process.exit(1);
}

const captured = { provider: undefined, commands: {}, clipboard: '' };
const configOverrides = {};
let nextInput;
let lastInfoMessage = '';

const vscode = {
  Uri: {
    joinPath: (base, ...parts) => {
      const full = path.join(base && base.path ? base.path : '', ...parts);
      return { path: full, fsPath: full, toString: () => `file://${full}` };
    },
    parse: (value) => ({
      path: value,
      fsPath: String(value).replace(/^file:\/\//, ''),
      toString: () => value,
    }),
  },
  window: {
    activeTextEditor: undefined,
    registerWebviewViewProvider: (_type, provider) => {
      captured.provider = provider;
      return { dispose() {} };
    },
    showInputBox: async () => nextInput,
    showWarningMessage: async () => undefined,
    showInformationMessage: async (message) => {
      lastInfoMessage = message;
      return undefined;
    },
  },
  commands: {
    registerCommand: (id, fn) => {
      captured.commands[id] = fn;
      return { dispose() {} };
    },
    executeCommand: async () => undefined,
  },
  workspace: {
    getConfiguration: () => ({
      get: (key, fallback) => (key in configOverrides ? configOverrides[key] : fallback),
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    asRelativePath: (uri) => path.relative(ROOT, uri.fsPath),
    workspaceFolders: [],
  },
  env: {
    clipboard: { writeText: async (text) => { captured.clipboard = text; } },
    openExternal: async () => true,
  },
  ConfigurationTarget: { Global: 1, Workspace: 2 },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') {
    return vscode;
  }
  return originalLoad.call(this, request, parent, isMain);
};

/* ---------- Мок-сервер OpenAI-совместимого API ---------- */

const modelsPayload = {
  data: [
    {
      id: 'openai/gpt-4o',
      name: 'GPT-4o',
      architecture: { input_modalities: ['text', 'image'] },
      top_provider: {
        context_length: 128000,
        supported_parameters: ['tools'],
        pricing: { prompt_per_million: '7.50', completion_per_million: '22.50', currency: 'RUB' },
      },
    },
    { id: 'local/tiny', name: 'Tiny' },
  ],
};

const sse = [
  'data: {"provider":"openai-direct","model":"openai/gpt-4o","choices":[{"delta":{"content":"При"}}]}',
  '',
  'data: {"choices":[{"delta":{"content":"вет"}}]}',
  '',
  'data: {"choices":[{"delta":{"content":"!"},"finish_reason":"stop"}]}',
  '',
  'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3,"total_tokens":8,"cost_rub":0.02}}',
  '',
  'data: [DONE]',
  '',
].join('\n');

const server = http.createServer((req, res) => {
  if (req.url.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(modelsPayload));
    return;
  }
  if (req.url === '/v1/chat/completions') {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      const payload = JSON.parse(body);
      assert.strictEqual(payload.messages.at(-1).content, 'привет');
      assert.strictEqual(payload.stream, true);
      assert.deepStrictEqual(payload.stream_options, { include_usage: true });

      res.writeHead(200, { 'content-type': 'text/event-stream' });
      // Режем SSE на произвольных границах — проверяем парсер
      let offset = 0;
      const step = () => {
        if (offset >= sse.length) {
          res.end();
          return;
        }
        const next = Math.min(offset + 23, sse.length);
        res.write(sse.slice(offset, next));
        offset = next;
        setTimeout(step, 1);
      };
      step();
    });
    return;
  }
  res.writeHead(404);
  res.end();
});

function waitFor(read, predicate, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = read().find(predicate);
      if (found) {
        resolve(found);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(new Error('Не дождались сообщения от расширения'));
        return;
      }
      setTimeout(tick, 10);
    };
    tick();
  });
}

server.listen(0, '127.0.0.1', async () => {
  const port = server.address().port;
  configOverrides.baseUrl = `http://127.0.0.1:${port}/v1`;
  configOverrides.model = 'openai/gpt-4o';
  configOverrides.modelsQuery = 'type=chat';

  const posted = [];
  let receive;
  const stateStore = new Map();
  const secretsStore = new Map([['omnillm.apiKey', 'test-key']]);

  const context = {
    extensionUri: { path: ROOT, fsPath: ROOT },
    subscriptions: [],
    workspaceState: {
      get: (key, fallback) =>
        stateStore.has(`ws:${key}`) ? stateStore.get(`ws:${key}`) : fallback,
      update: async (key, value) => { stateStore.set(`ws:${key}`, value); },
    },
    globalState: {
      get: (key, fallback) =>
        stateStore.has(`gs:${key}`) ? stateStore.get(`gs:${key}`) : fallback,
      update: async (key, value) => { stateStore.set(`gs:${key}`, value); },
    },
    secrets: {
      get: async (key) => secretsStore.get(key),
      store: async (key, value) => { secretsStore.set(key, value); },
      delete: async (key) => { secretsStore.delete(key); },
    },
  };

  const webview = {
    options: undefined,
    html: '',
    cspSource: 'vscode-resource://test',
    asWebviewUri: (uri) => `vscode-resource://test${uri.path}`,
    postMessage: async (message) => { posted.push(message); },
    onDidReceiveMessage: (handler) => { receive = handler; return { dispose() {} }; },
  };
  const view = {
    webview,
    onDidDispose: () => ({ dispose() {} }),
    show: () => undefined,
  };

  try {
    const extension = require(EXTENSION_ENTRY);
    extension.activate(context);

    assert.ok(captured.provider, 'провайдер должен зарегистрироваться');
    captured.provider.resolveWebviewView(view);

    assert.match(webview.html, /Content-Security-Policy/);
    assert.match(webview.html, /webview\.js/);
    assert.match(webview.html, /style\.css/);
    assert.match(webview.html, /nonce-/);

    receive({ type: 'ready' });
    const init = await waitFor(() => posted, (message) => message.type === 'init');
    assert.strictEqual(init.state.keySet, true);
    assert.strictEqual(init.state.model, 'openai/gpt-4o');
    assert.strictEqual(init.state.baseUrl, `http://127.0.0.1:${port}/v1`);

    const modelsLoaded = await waitFor(
      () => posted,
      (message) => message.type === 'models' && message.loading === false && message.models.length > 0,
    );
    assert.strictEqual(modelsLoaded.models.length, 2);
    assert.strictEqual(modelsLoaded.models[0].id, 'local/tiny');
    assert.strictEqual(
      modelsLoaded.models.find((model) => model.id === 'openai/gpt-4o').supportsTools,
      true,
    );

    receive({ type: 'send', text: 'привет' });
    const done = await waitFor(() => posted, (message) => message.type === 'done');
    const streamed = posted
      .filter((message) => message.type === 'chunk')
      .map((message) => message.text)
      .join('');
    assert.strictEqual(streamed, 'Привет!');
    assert.strictEqual(done.meta.provider, 'openai-direct');
    assert.strictEqual(done.meta.usage.cost_rub, 0.02);

    await waitFor(
      () => posted,
      (message) =>
        message.type === 'history' && message.messages.some((item) => item.role === 'user'),
    );

    const stored = stateStore.get('ws:omnillm.messages');
    assert.strictEqual(stored.length, 2);
    assert.strictEqual(stored[1].role, 'assistant');
    assert.strictEqual(stored[1].meta.usage.cost_rub, 0.02);

    /* Контекст из редактора */
    vscode.window.activeTextEditor = {
      document: {
        getText: () => 'const x = 1;\n',
        uri: { fsPath: path.join(ROOT, 'src', 'a.ts') },
        lineCount: 2,
        lineAt: () => ({ range: { end: {} } }),
      },
      selection: { isEmpty: true, start: { line: 0 }, end: { line: 0 } },
    };
    captured.commands['omnillm.addSelection']();
    const contextMessage = await waitFor(
      () => posted,
      (message) => message.type === 'context' && message.items.length > 0,
    );
    assert.strictEqual(contextMessage.items[0].label, 'src/a.ts#L1-2');
    assert.match(contextMessage.items[0].text, /const x = 1/);

    /* Буфер обмена */
    receive({ type: 'copyCode', code: 'console.log(1)' });
    await waitFor(
      () => posted,
      (message) => message.type === 'notice' && /скопирован/.test(message.message),
    );
    assert.strictEqual(captured.clipboard, 'console.log(1)');

    /* Новый чат */
    captured.commands['omnillm.newChat']();
    await waitFor(
      () => posted.slice().reverse(),
      (message) => message.type === 'history' && message.messages.length === 0,
    );

    /* Ключ: сохранение, проверка, удаление */
    nextInput = 'sk-test-abcdef123456';
    await captured.commands['omnillm.setApiKey']();
    const auth = await waitFor(
      () => posted,
      (message) => message.type === 'auth' && message.keySet === true,
    );
    assert.strictEqual(auth.hint, '••••3456');
    assert.strictEqual(secretsStore.get('omnillm.apiKey'), 'sk-test-abcdef123456');

    await captured.commands['omnillm.keyStatus']();
    assert.match(lastInfoMessage, /ключ сохранён/);
    assert.match(lastInfoMessage, /3456/);

    await captured.commands['omnillm.clearApiKey']();
    await waitFor(
      () => posted,
      (message) => message.type === 'auth' && message.keySet === false,
    );
    assert.strictEqual(secretsStore.has('omnillm.apiKey'), false);

    console.log('OK: активация, HTML, каталог, SSE, стоимость, история, контекст, ключ');
  } catch (error) {
    console.error('FAIL');
    console.error(error);
    process.exitCode = 1;
  } finally {
    server.close();
  }
});
