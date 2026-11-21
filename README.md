# OmniLLM

[![CI](https://github.com/barsuk228332/omnillm/actions/workflows/ci.yml/badge.svg)](https://github.com/barsuk228332/omnillm/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.90-007ACC.svg)](https://code.visualstudio.com/)

Чат с нейросетями в сайдбаре VS Code через любой OpenAI-совместимый API.
По умолчанию настроен на [Polza.ai](https://polza.ai), но работает и с OpenRouter,
Ollama, LM Studio и другими провайдерами.

<!-- После первого запуска добавь скриншот: docs/screenshot.png -->
<!-- ![Скриншот](docs/screenshot.png) -->

## Возможности

- **Сайдбар-чат** с потоковым ответом (SSE) и кнопкой Stop.
- **Каталог моделей** из `GET /models`: поиск, группировка по провайдеру,
  фильтры `tools` / `vision` / `reasoning`, контекст и цены.
- **Кнопка обновления** списка моделей и кэш на 24 часа.
- **Контекст редактора**: выделение (`Ctrl+Alt+A`) и текущий файл (`Ctrl+Alt+F`).
- **Работа с кодом**: «Копировать» и «Вставить» у каждого блока.
- **Стоимость ответа** — `usage.cost_rub`, токены и провайдер под сообщением.
- **Безопасность**: API-ключ в `context.secrets`, ключ никогда не пишется в `settings.json`.
- **Локальные модели**: Ollama/LM Studio работают без ключа.

## Установка

### Из исходников

```bash
npm ci
npm run package
code --install-extension omnillm-0.1.1.vsix
```

### Разработка

```bash
npm ci
npm run watch
```

Открой папку в VS Code и нажми **F5** — запустится Extension Development Host.

## Настройка

1. `Ctrl+Shift+P` → `OmniLLM: Задать API-ключ`.
2. При необходимости изменить `omnillm.baseUrl` (по умолчанию `https://polza.ai/api/v1`).
3. Открыть иконку OmniLLM в Activity Bar.

| Настройка | По умолчанию | Описание |
|---|---|---|
| `omnillm.baseUrl` | `https://polza.ai/api/v1` | Base URL OpenAI-совместимого API |
| `omnillm.modelsQuery` | `type=chat` | Query для `GET /models` (пусто — не передавать) |
| `omnillm.model` | `openai/gpt-4o` | Модель по умолчанию |
| `omnillm.systemPrompt` | ассистент-программист | Системный промпт |
| `omnillm.temperature` | `0.7` | Температура |
| `omnillm.maxTokens` | `4096` | Максимум токенов в ответе |
| `omnillm.maxContextChars` | `24000` | Бюджет истории в символах |
| `omnillm.requestTimeoutMs` | `180000` | Таймаут запроса |
| `omnillm.streamUsage` | `true` | Передавать `stream_options.include_usage` |

### Ollama

```json
{
  "omnillm.baseUrl": "http://localhost:11434/v1",
  "omnillm.modelsQuery": "",
  "omnillm.model": "qwen2.5-coder:7b"
}
```

Для локальных адресов ключ не требуется.

## Команды

| Команда | Действие |
|---|---|
| `OmniLLM: Открыть чат` | сфокусировать сайдбар |
| `OmniLLM: Новый чат` | очистить историю |
| `OmniLLM: Добавить выделение в контекст` | `Ctrl+Alt+A` |
| `OmniLLM: Добавить текущий файл в контекст` | `Ctrl+Alt+F` |
| `OmniLLM: Обновить список моделей` | принудительно перезагрузить каталог |
| `OmniLLM: Задать API-ключ` | сохранить ключ в secrets |
| `OmniLLM: Проверить API-ключ` | показать маску и длину ключа |
| `OmniLLM: Удалить API-ключ` | стереть ключ из secrets |

## Если ключ «не сохраняется»

Ключ пишется в `context.secrets` (системный keyring).

1. `Ctrl+Shift+P` → `OmniLLM: Проверить API-ключ` — покажет маску и длину.
2. Иконка ключа в сайдбаре становится зелёной, когда ключ задан.
3. На Linux без keyring (`gnome-keyring` / `KWallet`) секреты могут не
   сохраняться — расширение явно сообщит об этом при записи.

После сохранения список моделей перезагружается автоматически, баннер
«API-ключ не задан» исчезает сразу, без перезапуска окна.

## Поддерживаемые провайдеры

Любой сервис с OpenAI-совместимыми `GET /models` и `POST /chat/completions`:

- Polza.ai (по умолчанию, каталог с ценами в рублях);
- OpenRouter, OpenAI, Groq, Together;
- Ollama, LM Studio, llama.cpp server;
- собственные прокси и шлюзы.

Если провайдер не отдаёт `/models` — модель можно указать вручную в
`omnillm.model`, а `omnillm.modelsQuery` оставить пустым.

## Тесты

```bash
npm run typecheck
npm test
```

`npm test` собирает расширение и прогоняет интеграционный смоук: активация,
HTML с CSP, загрузка каталога, полный SSE-стрим, `usage`, история, контекст,
буфер обмена и сохранение ключа. VS Code для теста не нужен — модуль `vscode`
подменяется стабом, сеть — локальным мок-сервером.

## Структура

```
src/extension.ts      активация и команды
src/provider.ts       WebviewViewProvider, чат, контекст, модели
src/api.ts            OpenAI-совместимый клиент и парсер SSE
src/config.ts         настройки, secrets, нормализация base URL
src/protocol.ts       типы сообщений webview ⇄ extension
src/webview/main.ts   UI сайдбара
media/style.css       стили под темы VS Code
test/smoke.cjs        интеграционный смоук без VS Code
```

## Релиз

1. Обнови `version` в `package.json` и `CHANGELOG.md`.
2. Закоммить и поставь тег: `git tag v0.1.1 && git push origin v0.1.1`.
3. Workflow `Release` соберёт `.vsix` и приложит его к GitHub Release.

## Публикация в Open VSX / Marketplace

Сейчас `publisher` в `package.json` равен `local` — это удобно для локальной
установки. Перед публикацией:

1. Замени `publisher` на свой идентификатор.
2. Учти: extension ID (`publisher.name`) изменится, поэтому сохранённый ключ
   придётся ввести заново.
3. Для Open VSX: `npx ovsx publish omnillm-0.1.1.vsix -p <token>`.
4. Для Marketplace: `npx vsce publish` (нужен publisher в Azure DevOps).

## Перед публикацией на GitHub

Замени плейсхолдер в ссылках:

```bash
grep -rl barsuk228332 . --exclude-dir=node_modules --exclude-dir=.git \
  | xargs sed -i 's/barsuk228332/твой-username/g'
```

Затем:

```bash
git remote add origin https://github.com/твой-username/omnillm.git
git push -u origin main
```

## Лицензия

[MIT](LICENSE)
