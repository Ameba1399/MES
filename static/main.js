// Простая шина состояния
const $ = s => document.querySelector(s);
let ws, roomId, userName, myId = crypto.randomUUID();

function addMessage(name, text){
  const box = $('#chat');
  const div = document.createElement('div');
  div.className = 'message';
  div.innerHTML = `<div class="name">${name}</div><div class="text">${text}</div>`;
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
function renderUsers(list){
  const ul = $('#users');
  ul.innerHTML = '';
  list.forEach(p=>{
    const li = document.createElement('li');
    li.textContent = `${p.name} (${p.id.slice(0,6)})`;
    ul.appendChild(li);
  });
  $('#count').textContent = list.length;
}

function connect(){
  if(ws) ws.close();
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${roomId}`);
  ws.onopen = ()=>{
    ws.send(JSON.stringify({type:'join', id: myId, name: userName}));
  }
  ws.onmessage = ev=>{
    const data = JSON.parse(ev.data);
    if(data.type === 'participants'){
      renderUsers(data.participants);
    }else if(data.type === 'presence'){
      addMessage('Система', `${data.name} ${data.action === 'join' ? 'подключился' : 'вышел'}`);
      ws.send(JSON.stringify({type:'ping'})); // держим соединение активным
    }else if(data.type === 'chat'){
      addMessage(data.name, data.text);
    }
  }
  ws.onclose = ()=> addMessage('Система', 'Соединение закрыто');
}

$('#joinBtn').onclick = ()=>{
  roomId = $('#roomInput').value.trim();
  userName = $('#nameInput').value.trim() || 'guest';
  if(!roomId) return alert('Введите ID комнаты');
  connect();
};

$('#send').onclick = sendMsg;
$('#msg').addEventListener('keydown', e=>{
  if(e.key === 'Enter'){ sendMsg(); }
});
function sendMsg(){
  const t = $('#msg').value.trim();
  if(!t || !ws) return;
  ws.send(JSON.stringify({type:'chat', id: myId, name: userName, text: t}));
  $('#msg').value='';
}

$('#callBtn').onclick = ()=>{
  roomId = $('#roomInput').value.trim();
  userName = $('#nameInput').value.trim() || 'guest';
  if(!roomId) return alert('Сначала войдите в комнату');
  const url = `/call?room=${encodeURIComponent(roomId)}&name=${encodeURIComponent(userName)}&id=${encodeURIComponent(myId)}`;
  window.open(url, '_blank'); // новая вкладка
};
