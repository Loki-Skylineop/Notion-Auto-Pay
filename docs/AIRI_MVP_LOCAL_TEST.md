# Локальный тест AIRI → панель → Notion AI

Ветка в обоих репозиториях: `test/airi-notion-mvp`.

## Что уже реализовано

```text
AIRI (текст/голос)
  → POST /v1/airi/chat/completions
  → безопасный адаптер формата AIRI/xsAI
  → существующий /v1/messages
  → выбранный в панели workspace + модель Notion
  → Notion AI и подключённый к нему Windows MCP
```

- В панели есть admin-вкладка **API ключи**.
- Вкладка управляет одним тестовым ключом, моделью и маршрутом `auto`/закреплённый workspace.
- AIRI видит отдельный провайдер **Notion AI Gateway** и стабильную модель `notion-ai`.
- Каждый чат AIRI передаёт свой `x-airi-session-id`, поэтому продолжение чата использует тот же thread Notion в пределах текущего запуска сервера.
- Инструменты AIRI для этого провайдера отключены: компьютерными инструментами управляет только Notion, чтобы действие не выполнялось дважды.

## 1. Запуск панели локально

Откройте отдельный терминал:

```bat
cd /d C:\Users\Gname\Desktop\Notion\Notion-Auto-Pay
build.bat
```

Затем откройте:

```text
http://127.0.0.1:8081/dashboard/
```

Если в `config.yaml` настроен другой порт, используйте его.

## 2. Настройка маршрута

1. Войдите как администратор.
2. Откройте вкладку **API ключи**.
3. Выберите workspace, в котором подключён Windows MCP.
4. Выберите реальную модель Notion.
5. Нажмите **Сохранить маршрут**.
6. Скопируйте **Base URL** и **API key**.

Локальный Base URL по умолчанию:

```text
http://127.0.0.1:8081/v1/airi/
```

AIRI всегда отправляет `model: notion-ai`; панель подставляет модель, выбранную здесь.

## 3. Настройка AIRI

Запустите существующий launcher:

```bat
C:\Users\Gname\Desktop\Test\AIRI.bat
```

В AIRI:

1. `Settings → Providers`.
2. Добавьте **Notion AI Gateway**.
3. Вставьте Base URL и API key из панели.
4. В разделе `Consciousness` выберите:
   - provider: **Notion AI Gateway**;
   - model: **notion-ai**.
5. Создайте новый чат.

## 4. Безопасная проверка

Сначала отправьте только текстовый запрос без действий на компьютере:

```text
Ответь одним предложением: связь AIRI → панель → Notion работает?
```

Затем в том же чате:

```text
Какой был мой предыдущий вопрос?
```

Ожидается продолжение того же thread. После этого создайте новый чат AIRI — он должен получить отдельный thread.

Только после этих проверок используйте безопасное read-only действие через Windows MCP, например запросить заголовок активного окна. Не начинайте с удаления файлов, отправки сообщений, оплаты или изменения системных настроек.

## Быстрая диагностика

```powershell
Invoke-WebRequest http://127.0.0.1:8081/health

$headers = @{ Authorization = 'Bearer ВСТАВЬТЕ_КЛЮЧ_ИЗ_ПАНЕЛИ' }
Invoke-RestMethod http://127.0.0.1:8081/v1/airi/models -Headers $headers
```

Проверка CORS:

```powershell
$headers = @{
  Origin = 'http://localhost'
  'Access-Control-Request-Method' = 'POST'
  'Access-Control-Request-Headers' = 'authorization,content-type,x-airi-session-id,x-airi-round-id,x-airi-app-surface'
}
Invoke-WebRequest http://127.0.0.1:8081/v1/airi/chat/completions -Method Options -Headers $headers
```

## Ограничения MVP

- Один интеграционный ключ на весь сервер.
- Привязка AIRI session → Notion thread хранится в памяти и имеет TTL 30 минут; после перезапуска сервера она не восстанавливается.
- `x-airi-round-id` уже передаётся, но постоянная идемпотентность ещё не реализована.
- Интерактивные подтверждения и survey из Notion пока не возвращаются в UI AIRI.
- Выбор существующего старого thread Notion пока не добавлен; сейчас поддерживаются новый чат и продолжение текущего чата AIRI.
- Ключ провайдера AIRI хранится локально в настройках renderer; это допустимо для локального теста, но не финальная схема хранения.

## Перед тестом Windows MCP

Ранее опубликованный Windows MCP auth key нужно ротировать. Не используйте его как AIRI API key и не возвращайте старое значение в конфиги или историю Git.
