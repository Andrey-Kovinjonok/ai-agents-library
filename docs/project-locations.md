# Контракт `project-locations`

## Объекты данных

### `ProjectIdentity`

```ts
interface ProjectIdentity {
  canonicalPath: string;
  alias: string;
}
```

- `canonicalPath` — единственный идентификатор проекта внутри файла конкретного
  продукта.
- `alias` — читаемое имя папки. Оно помогает человеку найти проект, но само по
  себе не считается уникальным идентификатором.

Основная копия Git, дополнительная рабочая папка того же хранилища Git и
символическая ссылка возвращают одинаковый `ProjectIdentity`.

### `AgentProductPaths`

```ts
interface AgentProductPaths {
  agentsRoot: string;
  skillsDirectory: string;
  productDirectory: string;
  productConfigFile: string;
  projectsDirectory: string;
  projectDirectory: string;
}
```

Объект описывает только расположение. Содержимым `projectDirectory` и
дополнительными полями `config.json` владеет вызывающий продукт.

### Общая часть `config.json`

```ts
interface ProductConfigV1 {
  schemaVersion: 1;
  projects: Record<string, {
    directory: string;
    [productField: string]: unknown;
  }>;
  [productField: string]: unknown;
}
```

Ключ `projects` — канонический полный путь. `directory` — относительный путь,
который обязан находиться внутри `projects/` того же продукта. Все остальные
поля принадлежат продукту и сохраняются при подготовке новой связи.

## Функции

- `projectAlias(path, options)` строит читаемый псевдоним.
- `resolveProjectIdentity(path, options)` определяет канонический проект.
- `agentProductPaths(product, identity, options)` вычисляет пути без записи на
  диск.
- `resolveProductProject(product, path, options)` заново читает `config.json` и
  возвращает текущую связь вместе с полным объектом `config` без кеширования.
- `ensureProductProject(product, path, options)` безопасно создаёт или сохраняет
  связь и папку проекта продукта; в результате также возвращается уже
  обновлённый полный объект `config`.

## Безопасность и одновременная работа

- Имя продукта не может содержать переход к родительской папке.
- Связь из `config.json` не может выйти из `projects/` ни напрямую, ни через
  существующую символическую ссылку.
- Создание каждого уровня проверяется до перехода на следующий уровень.
- Изменение `config.json` защищено межпроцессной блокировкой и атомарной заменой
  файла, поэтому несколько агентов не теряют записи друг друга.
- Оставшаяся от аварийно завершившегося процесса блокировка не удаляется
  автоматически: операция останавливается с точным путём для ручного решения.
- Функций удаления, переноса старых мест и изменения рабочего проекта в модуле
  нет.
