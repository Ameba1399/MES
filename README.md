
# MES WebRTC (mesh) — FastAPI

Групповые звонки (WebRTC mesh) + чат и список участников. Адаптивный интерфейс (мобилки/планшеты/ПК).

## Как запустить локально (Docker)
```bash
docker-compose up --build
# затем откройте http://localhost:8000
```

## Как запустить без Docker
```bash
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --host 0.0.0.0 --port 8000 --workers 1
```

## Деплой на Koyeb
- Используйте этот репозиторий как источник.
- Подойдёт Dockerfile (по умолчанию). Либо buildpack + Procfile.
- Команда запуска: `uvicorn app:app --host 0.0.0.0 --port ${PORT:-8000} --workers 1`

## Особенности
- WebRTC **mesh** (каждый со всеми). Для небольших комнат.
- Сигналинг: WebSocket `/ws?room=ROOM&user=NAME`.
- UI:
  - Ввод `room-id` и имени, кнопки: **Микрофон**, **Камера**, **Экран**, **Участники/Чат**, **Выйти**.
  - Список участников и чат.
  - Сетка видео с именами.
- Без изменения голоса и без SFU (как и просили).

## Важно
- Для продакшна добавьте свой STUN/TURN (сейчас публичные STUN).
- Mesh подходит для 2–6 участников (в зависимости от сети/железа).
