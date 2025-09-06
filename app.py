from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from typing import Dict, Set, Any
from collections import defaultdict
import os
import json

app = FastAPI(title="MES", version="1.0.0")

# CORS (на случай фронта с другого домена)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

static_dir = os.path.join(os.path.dirname(__file__), "static")
os.makedirs(static_dir, exist_ok=True)
app.mount("/static", StaticFiles(directory=static_dir), name="static")

rooms: Dict[str, Set[WebSocket]] = defaultdict(set)
user_meta: Dict[WebSocket, Dict[str, Any]] = {}

@app.get("/", response_class=HTMLResponse)
async def root():
    return FileResponse(os.path.join(static_dir, "index.html"))

@app.get("/call", response_class=HTMLResponse)
async def call():
    return FileResponse(os.path.join(static_dir, "call.html"))

async def broadcast(room: str, payload: dict, except_ws: WebSocket | None = None):
    dead = []
    for ws in rooms[room]:
        if ws is except_ws:
            continue
        try:
            await ws.send_text(json.dumps(payload, ensure_ascii=False))
        except Exception:
            dead.append(ws)
    for ws in dead:
        rooms[room].discard(ws)
        user_meta.pop(ws, None)

@app.websocket("/ws/{room}")
async def ws_endpoint(websocket: WebSocket, room: str):
    await websocket.accept()
    rooms[room].add(websocket)
    try:
        while True:
            msg = await websocket.receive_text()
            data = json.loads(msg)
            mt = data.get("type")

            # Запоминаем мету пользователя при join
            if mt == "join":
                user_meta[websocket] = {
                    "id": data["id"],
                    "name": data.get("name", "guest"),
                    "room": room,
                }
                # Отправляем список участников
                participants = [
                    {"id": user_meta[w]["id"], "name": user_meta[w]["name"]}
                    for w in rooms[room]
                    if w in user_meta
                ]
                await websocket.send_text(json.dumps({
                    "type": "participants",
                    "participants": participants
                }, ensure_ascii=False))

                # Оповещение остальных
                await broadcast(room, {
                    "type": "presence",
                    "action": "join",
                    "id": data["id"],
                    "name": data.get("name", "guest")
                }, except_ws=websocket)

            elif mt == "chat":
                await broadcast(room, {
                    "type": "chat",
                    "id": data["id"],
                    "name": data.get("name", "guest"),
                    "text": data.get("text", "")
                })

            elif mt == "signal":
                # перекидываем сигнал конкретному получателю
                target_id = data.get("target")
                # находим websocket по айди
                target_ws = None
                for w in rooms[room]:
                    meta = user_meta.get(w)
                    if meta and meta["id"] == target_id:
                        target_ws = w
                        break
                if target_ws:
                    await target_ws.send_text(json.dumps({
                        "type": "signal",
                        "from": data.get("from"),
                        "signal": data.get("signal")
                    }))

            elif mt == "ping":
                await websocket.send_text(json.dumps({"type": "pong"}))

    except WebSocketDisconnect:
        pass
    finally:
        # при отключении
        meta = user_meta.get(websocket)
        rooms[room].discard(websocket)
        user_meta.pop(websocket, None)
        if meta:
            await broadcast(room, {
                "type": "presence",
                "action": "leave",
                "id": meta["id"],
                "name": meta["name"]
            })
