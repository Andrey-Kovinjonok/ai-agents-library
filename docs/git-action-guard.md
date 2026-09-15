# Одноразовые разрешения Git для агентных оболочек

## Назначение

Пользовательская команда `КОММИТЬ` разрешает ровно один успешный `git commit`.
Команда `ПУШ` разрешает ровно один успешный `git push`. Техническая ошибка не
расходует разрешение: агент получает короткую инструкцию исправить причину и
повторить ту же операцию.

Разрешение после первой попытки привязывается к четырём значениям:

- идентификатору агентного сеанса;
- общей папке `.git` репозитория;
- фактическому имени ветки;
- корню конкретного `worktree` (отдельной рабочей копии Git).

Успех `git commit` определяется изменением ссылки именно выбранной ветки. Изменение
другой локальной ветки разрешение не расходует. Успех `git push` определяется
нулевым кодом завершения команды.

Состояние записывается небольшим JSON-файлом в системный временный каталог. Вывод
команды, значения переменных окружения и содержимое файлов в него не записываются.

## Поддерживаемые оболочки

| Оболочка | Адаптер |
| --- | --- |
| Codex | `bin/git-action-guard-hook.js --harness codex` |
| Claude Code | `bin/git-action-guard-hook.js --harness claude` |
| Qwen Code | `bin/git-action-guard-hook.js --harness qwen` |
| Pi | `ai-agents-library/adapters/pi` |
| OMP (Oh My Pi) | `ai-agents-library/adapters/oh-my-pi` |
| OpenCode 1 | `ai-agents-library/adapters/opencode-v1` |
| OpenCode 2 | `ai-agents-library/adapters/opencode-v2` |

Codex, Claude Code и Qwen Code используют один исполняемый файл, но отдельную
нормализацию входных событий. Qwen Code признаёт команду пользователя только из
поля `submitted_prompt`: сгенерированное продолжение в поле `prompt` не может само
выдать разрешение.

Pi и OMP используют один внутренний регистратор событий, но имеют отдельные точки
экспорта. Это позволяет независимо менять упаковку двух проектов, не копируя
машину разрешений.

OpenCode 1 и OpenCode 2 имеют несовместимые интерфейсы расширений, поэтому для них
существуют два отдельных адаптера.

## События командных хуков

Для Codex, Claude Code и Qwen Code исполняемый файл нужно зарегистрировать на:

- `UserPromptSubmit` без фильтра инструментов;
- `PreToolUse` только для командной оболочки;
- `PostToolUse` только для командной оболочки;
- `PostToolUseFailure` только для командной оболочки, если оболочка предоставляет
  отдельное событие ошибки.

Записи `PreToolUse`, `PostToolUse` и `PostToolUseFailure` должны выполняться
последовательно относительно других хуков, которые изменяют команду.

## Проверенные источники интерфейсов

- Codex hooks: https://learn.chatgpt.com/docs/hooks
- Claude Code hooks: https://code.claude.com/docs/en/hooks-guide
- Qwen Code hooks: https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/
- OpenCode 2 plugins: https://opencode.ai/v2/docs/build/plugins
- OpenCode 1 plugins: https://opencode.ai/docs/plugins/
- Pi extensions: https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/extensions.md
- OMP repository and extension model: https://github.com/bit-cook/oh-my-pi-coding-agent

## Текущее подключение

На машине разработки Codex вызывает существующие Python-хуки. Их новый файл
`git_permission_state_node.py` является переходником: он передаёт операции общей
Node.js-машине из `bin/git-action-permission-state.js`. Старый Python-файл машины
состояний не импортируется, но автоматически не удаляется.

Адаптеры остальных оболочек входят в библиотеку и проверяются отдельно. Команда
`install-git-action-guard --agent all --opencode-major 1` устанавливает их во все
поддерживаемые оболочки. Значение `--opencode-major` задаётся явно: `1` подключает
интерфейс установленной ветки OpenCode 1, `2` подключает новый интерфейс OpenCode 2.
Установщик дополняет существующие массивы хуков и прекращает работу до записи при
конфликтующем файле адаптера.
