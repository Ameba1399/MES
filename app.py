
import os
import json
import uuid
from typing import Dict, Set
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from starlette.staticfiles import StaticFiles

APP_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(APP_DIR, "static")

app = FastAPI(title="MES WebRTC")

origins = [
    "https://ameba1399.github.io",
    "https://mes.koyeb.app",
]

# CORS (tune in production)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve static UI
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")

@app.get("/", response_class=HTMLResponse)
async def root():
    # Serve index.html
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))

# ---- Simple in-memory room manager ----
class RoomManager:
    def __init__(self):
        # room_id -> { user_id: websocket }
        self.rooms: Dict[str, Dict[str, WebSocket]] = {}

    def room_users(self, room_id: str):
        return self.rooms.get(room_id, {})

    async def connect(self, room_id: str, user_id: str, ws: WebSocket):
        await ws.accept()
        if room_id not in self.rooms:
            self.rooms[room_id] = {}
        self.rooms[room_id][user_id] = ws

    def disconnect(self, room_id: str, user_id: str):
        if room_id in self.rooms and user_id in self.rooms[room_id]:
            del self.rooms[room_id][user_id]
            if not self.rooms[room_id]:
                del self.rooms[room_id]

    async def broadcast(self, room_id: str, message: dict, exclude: Set[str] | None = None):
        exclude = exclude or set()
        users = dict(self.room_users(room_id))
        for uid, ws in users.items():
            if uid in exclude:
                continue
            try:
                await ws.send_text(json.dumps(message))
            except Exception:
                # ignore send errors
                pass

manager = RoomManager()

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    # Expect ?room=ROOM&user=NAME
    params = ws.query_params
    room_id = params.get("room") or "default"
    display_name = params.get("user") or "guest"
    user_id = str(uuid.uuid4())

    await manager.connect(room_id, user_id, ws)

    # Notify others about join
    await manager.broadcast(
        room_id,
        {"type": "peer-join", "userId": user_id, "name": display_name},
        exclude={user_id},
    )

    # Send initial state (who's already in the room)
    existing = [
        {"userId": uid, "name": f"peer-{uid[:4]}"}
        for uid in manager.room_users(room_id).keys()
        if uid != user_id
    ]
    await ws.send_text(json.dumps({"type": "room-state", "peers": existing, "selfId": user_id, "name": display_name}))

    try:
        while True:
            raw = await ws.receive_text()
            data = json.loads(raw)

            # Relay signaling messages to specific peer(s)
            if data.get("type") in {"webrtc-offer", "webrtc-answer", "webrtc-ice"}:
                target = data.get("target")
                if target:
                    target_ws = manager.room_users(room_id).get(target)
                    if target_ws:
                        payload = data | {"from": user_id}
                        await target_ws.send_text(json.dumps(payload))

            # Chat messages broadcast
            elif data.get("type") == "chat-message":
                await manager.broadcast(room_id, {
                    "type": "chat-message",
                    "from": user_id,
                    "name": display_name,
                    "text": data.get("text", "")
                })

            # Control messages (mute/cam/etc) just rebroadcast
            elif data.get("type") == "control":
                await manager.broadcast(room_id, data | {"from": user_id}, exclude={user_id})

            # Request current peers list
            elif data.get("type") == "get-peers":
                peers = [
                    {"userId": uid, "name": f"peer-{uid[:4]}"}
                    for uid in manager.room_users(room_id).keys()
                    if uid != user_id
                ]
                await ws.send_text(json.dumps({"type": "room-state", "peers": peers, "selfId": user_id}))

    except WebSocketDisconnect:
        pass
    finally:
        manager.disconnect(room_id, user_id)
        await manager.broadcast(room_id, {"type": "peer-leave", "userId": user_id})
