const qs = new URLSearchParams(location.search);
const roomId = qs.get('room') || 'room1';
const userName = qs.get('name') || 'guest';
const myId = qs.get('id') || crypto.randomUUID();
document.getElementById('roomBadge').textContent = `Комната: ${roomId}`;

const peers = new Map(); // peerId -> RTCPeerConnection
const streams = new Map(); // peerId -> MediaStream
let localStream = new MediaStream();
let ws;

const $ = s=>document.querySelector(s);
const videosWrap = $('#videos');

function addVideo(stream, id, label){
  let v = document.getElementById('v_'+id);
  if(!v){
    v = document.createElement('video');
    v.id = 'v_'+id;
    v.autoplay = true;
    v.playsInline = true;
    v.title = label || id;
    videosWrap.appendChild(v);
  }
  if(v.srcObject !== stream) v.srcObject = stream;
}

async function setupLocal(){
  try{
    const a = await navigator.mediaDevices.getUserMedia({audio:true, video:true});
    a.getTracks().forEach(t=> localStream.addTrack(t));
    addVideo(localStream, 'me', userName + ' (вы)');
  }catch(e){
    console.warn('No cam/mic', e);
  }
}

function createPeer(remoteId){
  if(peers.has(remoteId)) return peers.get(remoteId);
  const pc = new RTCPeerConnection({iceServers:[{urls:'stun:stun.l.google.com:19302'}]});
  localStream.getTracks().forEach(t=> pc.addTrack(t, localStream));
  pc.ontrack = ev=>{
    let s = streams.get(remoteId) || new MediaStream();
    streams.set(remoteId, s);
    s.addTrack(ev.track);
    addVideo(s, remoteId, remoteId);
  };
  pc.onicecandidate = ev=>{
    if(ev.candidate){
      ws.send(JSON.stringify({type:'signal', from: myId, target: remoteId, signal: {type:'candidate', candidate: ev.candidate}}));
    }
  };
  peers.set(remoteId, pc);
  return pc;
}

async function makeOffer(remoteId){
  const pc = createPeer(remoteId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({type:'signal', from: myId, target: remoteId, signal: {type:'offer', sdp: offer}}));
}

async function handleSignal(from, signal){
  const pc = createPeer(from);
  if(signal.type === 'offer'){
    await pc.setRemoteDescription(signal.sdp);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    ws.send(JSON.stringify({type:'signal', from: myId, target: from, signal: {type:'answer', sdp: answer}}));
  }else if(signal.type === 'answer'){
    await pc.setRemoteDescription(signal.sdp);
  }else if(signal.type === 'candidate'){
    try{ await pc.addIceCandidate(signal.candidate); }catch(e){ console.warn(e); }
  }
}

function removePeer(id){
  const pc = peers.get(id);
  if(pc){
    pc.getSenders().forEach(s=> pc.removeTrack(s));
    pc.close();
  }
  peers.delete(id);
  const v = document.getElementById('v_'+id);
  if(v){ v.srcObject=null; v.remove(); }
  streams.delete(id);
}

async function init(){
  await setupLocal();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`);
  ws.onopen = ()=>{
    ws.send(JSON.stringify({type:'join', id: myId, name: userName}));
  };
  ws.onmessage = async ev => {
    const data = JSON.parse(ev.data);
    if(data.type === 'participants'){
      (data.participants || []).forEach(p=>{
        if(p.id !== myId){
          // инициируем оффер всем уже в комнате
          makeOffer(p.id);
        }
      });
    }else if(data.type === 'presence'){
      if(data.action === 'join' && data.id !== myId){
        // новый участник — мы инициируем оффер
        makeOffer(data.id);
      }else if(data.action === 'leave'){
        removePeer(data.id);
      }
    }else if(data.type === 'signal' && data.from !== myId){
      await handleSignal(data.from, data.signal);
    }
  };
  ws.onclose = ()=> leave();
}

init();

// UI controls
$('#micBtn').onclick = ()=>{
  localStream.getAudioTracks().forEach(t=> t.enabled = !t.enabled);
};
$('#camBtn').onclick = ()=>{
  localStream.getVideoTracks().forEach(t=> t.enabled = !t.enabled);
};
$('#screenBtn').onclick = async ()=>{
  try{
    const scr = await navigator.mediaDevices.getDisplayMedia({video:true, audio:false});
    const track = scr.getVideoTracks()[0];
    // заменяем видео-трек в отправке
    for(const pc of peers.values()){
      const sender = pc.getSenders().find(s=> s.track && s.track.kind==='video');
      if(sender) await sender.replaceTrack(track);
    }
    track.onended = async ()=>{
      // вернуть камеру
      const cam = localStream.getVideoTracks()[0];
      for(const pc of peers.values()){
        const sender = pc.getSenders().find(s=> s.track && s.track.kind==='video');
        if(sender) await sender.replaceTrack(cam);
      }
      addVideo(localStream, 'me', userName + ' (вы)');
    };
    const s = new MediaStream([track, ...localStream.getAudioTracks()]);
    addVideo(s, 'me', userName + ' (вы, экран)');
  }catch(e){ console.warn(e); }
};
function leave(){
  try{ ws && ws.close(); }catch(_){}
  peers.forEach((_, id)=> removePeer(id));
  localStream.getTracks().forEach(t=> t.stop());
  setTimeout(()=> window.close(), 50);
}
$('#leaveBtn').onclick = leave;
