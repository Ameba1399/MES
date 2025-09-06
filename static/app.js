// MES WebRTC Group Calls (mesh) with participants list
const els = {
  roomId: document.getElementById("roomId"),
  username: document.getElementById("username"),
  joinBtn: document.getElementById("joinBtn"),
  leaveBtn: document.getElementById("leaveBtn"),
  usersList: document.getElementById("usersList"),
  count: document.getElementById("count"),
  grid: document.getElementById("grid"),
  localVideo: document.getElementById("localVideo"),
  micBtn: document.getElementById("micBtn"),
  camBtn: document.getElementById("camBtn"),
  shareBtn: document.getElementById("shareBtn"),
};

let ws = null;
let me = null;
let room = null;
let localStream = null;
let screenStream = null;
const peers = new Map(); // username -> { pc, streams, videoEl }

const RTC_CFG = {
  iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478?transport=udp" },
  ],
};

function wsUrl(path) {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  return `${proto}://${location.host}${path}`;
}

function uiConnected(state) {
  const on = state === true;
  els.joinBtn.disabled = on;
  els.leaveBtn.disabled = !on;
  [els.micBtn, els.camBtn, els.shareBtn].forEach(b=>{
    b.disabled = !on; b.classList.toggle("disabled", !on);
  });
}

function addUserToList(user) {
  const li = document.createElement("li");
  li.id = `user-${user}`;
  li.textContent = user;
  if (user === me) {
    const tag = document.createElement("span");
    tag.textContent = "вы";
    tag.className = "me-tag";
    li.appendChild(tag);
  }
  els.usersList.appendChild(li);
}

function removeUserFromList(user) {
  const el = document.getElementById(`user-${user}`);
  if (el) el.remove();
}

function setParticipants(users) {
  els.usersList.innerHTML = "";
  users.forEach(addUserToList);
  els.count.textContent = users.length;
}

function addVideoTile(user) {
  if (document.getElementById(`tile-${user}`)) return;
  const video = document.createElement("video");
  video.id = `tile-${user}`;
  video.autoplay = true;
  video.playsInline = true;
  video.className = "tile";
  video.setAttribute("data-user", user);
  els.grid.appendChild(video);
  return video;
}

function removeVideoTile(user) {
  const tile = document.getElementById(`tile-${user}`);
  if (tile) tile.remove();
}

async function ensureLocalMedia() {
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia({audio: true, video: true});
  els.localVideo.srcObject = localStream;
  els.localVideo.classList.remove("hidden");
  return localStream;
}

function createPeer(user) {
  const pc = new RTCPeerConnection(RTC_CFG);
  const entry = { pc, streams: [], videoEl: addVideoTile(user) };
  peers.set(user, entry);

  // add local tracks
  for (const track of (localStream?.getTracks() || [])) {
    pc.addTrack(track, localStream);
  }

  pc.ontrack = (ev) => {
    const [stream] = ev.streams;
    entry.streams.push(stream);
    if (entry.videoEl) entry.videoEl.srcObject = stream;
  };

  pc.onicecandidate = (ev) => {
    if (ev.candidate) {
      send({ type: "ice", from: me, to: user, candidate: ev.candidate });
    }
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "failed" || pc.connectionState === "disconnected") {
      console.log("Peer disconnected:", user);
    }
  };

  return entry;
}

async function callUser(user) {
  if (user === me) return;
  let entry = peers.get(user);
  if (!entry) entry = createPeer(user);
  const { pc } = entry;
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  send({ type: "offer", from: me, to: user, offer });
}

async function handleOffer(msg) {
  const from = msg.from;
  let entry = peers.get(from);
  if (!entry) entry = createPeer(from);
  const { pc } = entry;
  await pc.setRemoteDescription(new RTCSessionDescription(msg.offer));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  send({ type: "answer", from: me, to: from, answer });
}

function handleAnswer(msg) {
  const from = msg.from;
  const entry = peers.get(from);
  if (entry) {
    entry.pc.setRemoteDescription(new RTCSessionDescription(msg.answer));
  }
}

function handleIce(msg) {
  const from = msg.from;
  const entry = peers.get(from);
  if (entry && msg.candidate) {
    entry.pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
  }
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

async function join() {
  room = els.roomId.value.trim();
  me = els.username.value.trim();
  if (!room || !me) {
    alert("Укажи комнату и имя"); return;
  }
  await ensureLocalMedia();

  ws = new WebSocket(wsUrl(`/ws/${encodeURIComponent(room)}/${encodeURIComponent(me)}`));
  ws.onopen = () => uiConnected(true);
  ws.onclose = () => {
    uiConnected(false);
    cleanup();
  };
  ws.onerror = () => console.warn("WebSocket error");

  ws.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);
    switch (msg.type) {
      case "you":
        if (msg.username && msg.username !== me) {
          me = msg.username;
          // Update my label in list when participants arrive next
        }
        break;
      case "participants":
        setParticipants(msg.users);
        // Call anyone we don't have a connection to yet
        for (const user of msg.users) {
          if (user !== me && !peers.has(user)) {
            await callUser(user);
          }
        }
        break;
      case "user-join":
        addUserToList(msg.user);
        els.count.textContent = document.querySelectorAll("#usersList li").length;
        // slight delay to ensure other side has media ready
        setTimeout(() => callUser(msg.user), 300);
        break;
      case "user-leave":
        removeUserFromList(msg.user);
        els.count.textContent = document.querySelectorAll("#usersList li").length;
        hangupPeer(msg.user);
        break;
      case "offer":
        await handleOffer(msg);
        break;
      case "answer":
        handleAnswer(msg);
        break;
      case "ice":
        handleIce(msg);
        break;
    }
  };
}

function hangupPeer(user) {
  const entry = peers.get(user);
  if (entry) {
    try { entry.pc.getSenders().forEach(s=>entry.pc.removeTrack(s)); } catch {}
    try { entry.pc.close(); } catch {}
    peers.delete(user);
  }
  removeVideoTile(user);
}

async function leave() {
  send({ type: "bye", from: me, to: "__all__" });
  if (ws) try { ws.close(); } catch {}
  cleanup();
}

function cleanup() {
  for (const user of Array.from(peers.keys())) hangupPeer(user);
  if (localStream) {
    for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }
  if (screenStream) {
    for (const t of screenStream.getTracks()) t.stop();
    screenStream = null;
  }
  els.localVideo.srcObject = null;
  els.localVideo.classList.add("hidden");
  setParticipants([]);
}

function toggleMic() {
  if (!localStream) return;
  const a = localStream.getAudioTracks()[0];
  if (!a) return;
  a.enabled = !a.enabled;
  els.micBtn.classList.toggle("active", a.enabled);
  els.micBtn.classList.toggle("danger", !a.enabled);
}

function toggleCam() {
  if (!localStream) return;
  const v = localStream.getVideoTracks()[0];
  if (!v) return;
  v.enabled = !v.enabled;
  els.camBtn.classList.toggle("active", v.enabled);
  els.camBtn.classList.toggle("danger", !v.enabled);
}

async function shareScreen() {
  if (screenStream) {
    // stop screenshare
    for (const t of screenStream.getTracks()) t.stop();
    screenStream = null;
    // replace back with camera
    const camTrack = (await ensureLocalMedia()).getVideoTracks()[0];
    replaceOutgoingVideoTrack(camTrack);
    els.shareBtn.classList.remove("active");
    return;
  }
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
    const screenTrack = screenStream.getVideoTracks()[0];
    replaceOutgoingVideoTrack(screenTrack);
    els.shareBtn.classList.add("active");
    screenTrack.onended = () => {
      if (screenStream) {
        for (const t of screenStream.getTracks()) t.stop();
        screenStream = null;
      }
      ensureLocalMedia().then(s => replaceOutgoingVideoTrack(s.getVideoTracks()[0]));
      els.shareBtn.classList.remove("active");
    };
  } catch (e) {
    console.warn("Screen share rejected", e);
  }
}

function replaceOutgoingVideoTrack(newTrack) {
  // Update local preview
  const current = els.localVideo.srcObject;
  if (current) {
    const send = current.getVideoTracks()[0];
    if (send) current.removeTrack(send);
    current.addTrack(newTrack);
    els.localVideo.srcObject = current;
  } else {
    const s = new MediaStream([newTrack, ...((localStream?.getAudioTracks() || []))]);
    els.localVideo.srcObject = s;
  }

  // Replace in all peer connections
  for (const { pc } of peers.values()) {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === "video");
    if (sender) sender.replaceTrack(newTrack);
  }
}

els.joinBtn.addEventListener("click", join);
els.leaveBtn.addEventListener("click", leave);
els.micBtn.addEventListener("click", toggleMic);
els.camBtn.addEventListener("click", toggleCam);
els.shareBtn.addEventListener("click", shareScreen);

// Autocomplete sample defaults for ease of testing
if (!els.roomId.value) els.roomId.value = "demo-room";
if (!els.username.value) els.username.value = "user" + Math.floor(Math.random() * 1000);
