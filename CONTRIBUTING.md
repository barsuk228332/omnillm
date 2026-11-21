# Как внести вклад

Спасибо за интерес к OmniLLM!

## Локальный запуск

```bash
npm ci
npm run watch
```

Затем открой папку в VS Code и нажми **F5**.

## Перед pull request

```bash
npm run typecheck
npm test
```

Оба шага прогоняются в CI, PR без них не будет смержен.

## Стиль кода

- TypeScript, `strict: true`, без `any` там, где можно обойтись типами.
- Сообщения интерфейса — по-русски; код и комментарии — по-английски.
- Новые настройки добавляй в `package.json` (`contributes.configuration`),
  в интерфейс `Settings` и в README.
- Новые сообщения webview ⇄ extension — в `src/protocol.ts`, без «магических» строк.

## Коммиты

Используй [Conventional Commits](https://www.conventionalcommits.org/ru/):

```
feat: добавить тул-коллинг
fix: не терять ключ при перезапуске
docs: обновить инструкцию по Ollama
```

## Идеи и баги

Открывай issue по шаблону — так быстрее разобраться.
