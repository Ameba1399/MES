
/**
 * MES WebRTC (mesh) – no SFU
 * - Multiple peers in a room, each has RTCPeerConnection to every other.
 * - Signaling via FastAPI WebSocket /ws?room=...&user=...
 */

const qs = (sel) => document.querySelector(sel);
const roomInput = qs('#roomId');
const nameInput = qs('#displayName');
const joinBtn = qs('#joinBtn');
const leaveBtn = qs('#leaveBtn');
const grid = qs('#videoGrid');
const participantsEl = qs('#participants');
const messagesEl = qs('#messages');
const chatInput = qs('#chatInput');
const sendBtn = qs('#sendBtn');
const toggleMicBtn = qs('#toggleMic');
const toggleCamBtn = qs('#toggleCam');
const shareScreenBtn = qs('#shareScreen');
const toggleSidebarBtn = qs('#toggleSidebar');
const sidebar = qs('#sidebar');

// Restore from URL hash room=xxx&name=yyy
const params = new URLSearchParams(location.hash.slice(1));
if (params.get('room')) roomInput.value = params.get('room');
if (params.get('name')) nameInput.value = params.get('name');

let ws = null;
let selfId = null;
let displayName = null;
let roomId = null;
let localStream = null;
let screenTrack = null;

const peers = new Map(); // peerId -> RTCPeerConnection
const senders = new Map(); // peerId -> {audio, video}
const mediaConstraints = { audio: true, video: { width: {ideal: 1280}, height: {ideal: 720} } };

function logMsg(from, text){
  const div = document.createElement('div');
  div.className = 'msg';
  div.innerHTML = `<span class="from">${from}:</span> ${text}`;
  messagesEl.appendChild(div);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function participantItem(id, name){
  const el = document.createElement('div');
  el.className = 'participant';
  el.id = `p-${id}`;
  el.innerHTML = `<div class="avatar">${name[0]?.toUpperCase() ?? 'U'}</div>
                  <div style="display:flex;gap:.4rem;align-items:center;">
                    <div>${name}</div>
                    <span class="badge" id="b-${id}">в сети</span>
                  </div>`;
  return el;
}

function ensureTile(id, name, stream, isSelf=false){
  let tile = document.getElementById(`tile-${id}`);
  if (!tile){
    tile = document.createElement('div');
    tile.className = 'tile';
    tile.id = `tile-${id}`;
    tile.innerHTML = `<video id="v-${id}" autoplay playsinline ${isSelf ? 'muted' : ''}></video>
                      <div class="name">${isSelf ? name + ' (вы)' : name}</div>`;
    grid.appendChild(tile);
  }
  if (stream){
    const v = tile.querySelector('video');
    if (v.srcObject !== stream) v.srcObject = stream;
  }
  return tile;
}

function removePeer(id){
  const pc = peers.get(id);
  if (pc){ pc.close(); }
  peers.delete(id);
  const tile = document.getElementById(`tile-${id}`);
  if (tile) tile.remove();
  const item = document.getElementById(`p-${id}`);
  if (item) item.remove();
}

async function getLocalMedia(){
  if (localStream) return localStream;
  localStream = await navigator.mediaDevices.getUserMedia(mediaConstraints);
  ensureTile('self', displayName, localStream, true);
  return localStream;
}

function wsSend(obj){
  if (ws?.readyState === WebSocket.OPEN){
    ws.send(JSON.stringify(obj));
  }
}

function createPeerConnection(peerId){
  const pc = new RTCPeerConnection({
    iceServers: [
      { urls: "stun:stun.l.google.com:19302" },
      { urls: "stun:stun.cloudflare.com:3478" }
    ]
  });

  pc.onicecandidate = (e) => {
    if (e.candidate){
      wsSend({ type: "webrtc-ice", target: peerId, candidate: e.candidate });
    }
  };
  pc.ontrack = (e) => {
    const [stream] = e.streams;
    ensureTile(peerId, `peer-${peerId.slice(0,4)}`, stream);
  };
  pc.onconnectionstatechange = () => {
    const badge = document.getElementById(`b-${peerId}`);
    if (!badge) return;
    badge.textContent = pc.connectionState;
  };

  peers.set(peerId, pc);
  return pc;
}

async function callPeer(peerId){
  const pc = createPeerConnection(peerId);
  const stream = await getLocalMedia();
  const audioSender = pc.addTrack(stream.getAudioTracks()[0], stream);
  const videoSender = pc.addTrack(stream.getVideoTracks()[0], stream);
  senders.set(peerId, {audio: audioSender, video: videoSender});

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  wsSend({ type: "webrtc-offer", target: peerId, sdp: offer });
}

async function handleOffer(from, sdp){
  const pc = createPeerConnection(from);
  const stream = await getLocalMedia();
  const audioSender = pc.addTrack(stream.getAudioTracks()[0], stream);
  const videoSender = pc.addTrack(stream.getVideoTracks()[0], stream);
  senders.set(from, {audio: audioSender, video: videoSender});

  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  wsSend({ type: "webrtc-answer", target: from, sdp: answer });
}

async function handleAnswer(from, sdp){
  const pc = peers.get(from);
  if (!pc) return;
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

async function handleIce(from, candidate){
  const pc = peers.get(from);
  if (!pc) return;
  try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); } catch (e){ /* noop */ }
}

function updateParticipants(peersList){
  peersList.forEach(p => {
    if (!document.getElementById(`p-${p.userId}`)){
      participantsEl.appendChild(participantItem(p.userId, p.name));
    }
  });
}

async function join(){
  roomId = roomInput.value.trim() || "default";
  displayName = nameInput.value.trim() || "guest";
  location.hash = `room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(displayName)}`;

  ws = new WebSocket(`${location.origin.replace('http','ws')}/ws?room=${encodeURIComponent(roomId)}&user=${encodeURIComponent(displayName)}`);
  ws.onopen = async () => {
    joinBtn.style.display = 'none';
    leaveBtn.style.display = '';
    await getLocalMedia();
  };
  ws.onmessage = async (ev) => {
    const data = JSON.parse(ev.data);
    if (data.type === 'room-state'){
      selfId = data.selfId;
      updateParticipants(data.peers);
      // call everyone already in the room
      for (const p of data.peers){
        await callPeer(p.userId);
      }
    } else if (data.type === 'peer-join'){
      if (!document.getElementById(`p-${data.userId}`)){
        participantsEl.appendChild(participantItem(data.userId, data.name || `peer-${data.userId.slice(0,4)}`));
      }
      // we are responsible to call the new peer
      await callPeer(data.userId);
    } else if (data.type === 'peer-leave'){
      removePeer(data.userId);
    } else if (data.type === 'webrtc-offer'){
      await handleOffer(data.from, data.sdp);
    } else if (data.type === 'webrtc-answer'){
      await handleAnswer(data.from, data.sdp);
    } else if (data.type === 'webrtc-ice'){
      await handleIce(data.from, data.candidate);
    } else if (data.type === 'chat-message'){
      logMsg(data.name || data.from, data.text);
    }
  };
  ws.onclose = () => {
    leave();
  };
}

function leave(){
  for (const [peerId, pc] of peers){
    pc.close();
  }
  peers.clear();
  grid.querySelectorAll('.tile').forEach(el => { if (!el.id.startsWith('tile-self')) el.remove(); });
  participantsEl.innerHTML = '';
  if (ws){ ws.close(); ws = null; }
  joinBtn.style.display = '';
  leaveBtn.style.display = 'none';
}

joinBtn.addEventListener('click', join);
leaveBtn.addEventListener('click', leave);

sendBtn.addEventListener('click', () => {
  const text = chatInput.value.trim();
  if (!text) return;
  chatInput.value = '';
  wsSend({ type: 'chat-message', text });
  logMsg(displayName || 'я', text);
});
chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') sendBtn.click();
});

toggleMicBtn.addEventListener('click', async () => {
  await getLocalMedia();
  const track = localStream.getAudioTracks()[0];
  track.enabled = !track.enabled;
  toggleMicBtn.textContent = track.enabled ? 'Микрофон' : 'Микрофон (выкл)';
});

toggleCamBtn.addEventListener('click', async () => {
  await getLocalMedia();
  const track = localStream.getVideoTracks()[0];
  track.enabled = !track.enabled;
  toggleCamBtn.textContent = track.enabled ? 'Камера' : 'Камера (выкл)';
});

shareScreenBtn.addEventListener('click', async () => {
  try{
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    screenTrack = stream.getVideoTracks()[0];

    // replace video sender track for all peers
    for (const [peerId, send] of senders){
      if (send.video) await send.video.replaceTrack(screenTrack);
    }

    // preview self
    const selfTileVideo = document.querySelector('#tile-self video');
    if (selfTileVideo){
      const newStream = new MediaStream([localStream.getAudioTracks()[0], screenTrack]);
      selfTileVideo.srcObject = newStream;
    }

    screenTrack.onended = async () => {
      // revert back to camera
      const camTrack = localStream.getVideoTracks()[0];
      for (const [peerId, send] of senders){
        if (send.video) await send.video.replaceTrack(camTrack);
      }
      const selfTileVideo = document.querySelector('#tile-self video');
      if (selfTileVideo){
        const newStream = new MediaStream([localStream.getAudioTracks()[0], camTrack]);
        selfTileVideo.srcObject = newStream;
      }
    };
  }catch(err){
    console.warn('Screen share cancelled or failed', err);
  }
});

toggleSidebarBtn.addEventListener('click', () => {
  sidebar.style.display = (sidebar.style.display === 'none') ? '' : 'none';
});

// Auto-join if room preset
if (roomInput.value){ /* delayed to allow autoplay policy */
  setTimeout(() => { /* don't auto-join on mobile without touch */ }, 0);
}
