const $=s=>document.querySelector(s),audio=$("#audio"),clientId=crypto.randomUUID();
let socket,room=new URL(location.href).searchParams.get("room")||"",episode=null,applying=false,lastSent=0,reconnectTimer=null,connectionId=0,retryDelay=1000;
const toast=msg=>{const el=$("#toast");el.textContent=msg;el.classList.add("show");setTimeout(()=>el.classList.remove("show"),2200)};
function showEpisode(info){episode=info;$("#cover").src=info.image;$("#title").textContent=info.title;$("#podcast").textContent=info.podcast||"小宇宙播客";if(audio.src!==info.audio)audio.src=info.audio;$("#playerCard").classList.remove("hidden")}
async function loadEpisode(url=$("#episodeUrl").value){if(!url)return toast("请先粘贴分享链接");$("#load").textContent="载入中…";try{const r=await fetch(`/api/episode?url=${encodeURIComponent(url)}`),data=await r.json();if(!r.ok)throw new Error(data.error);showEpisode(data);send({type:"state",state:snapshot()});toast("单集载入成功")}catch(e){toast(e.message)}finally{$("#load").textContent="载入"}}
function snapshot(){return{episode,paused:audio.paused,currentTime:audio.currentTime||0,playbackRate:audio.playbackRate}}
function send(payload){if(socket?.readyState===1)socket.send(JSON.stringify({...payload,sender:clientId,sentAt:Date.now()}))}
function inviteLink(){const url=new URL(location.origin);url.searchParams.set("room",room);return url.toString()}
function revealInvite(){const url=inviteLink();history.replaceState({},"",url);$("#inviteUrl").value=url;$("#shareBox").classList.remove("hidden")}
async function copyInvite(){const url=inviteLink();let copied=false;try{await navigator.clipboard.writeText(url);copied=true}catch{}if(!copied){const input=$("#inviteUrl");input.focus();input.select();copied=document.execCommand("copy")}toast(copied?"邀请链接已复制":"请长按链接选择复制")}
function connect(code){
  room=code;revealInvite();clearTimeout(reconnectTimer);const id=++connectionId;
  if(socket&&socket.readyState<2){socket.onclose=null;socket.close()}
  const ws=new WebSocket(`${location.origin.replace(/^http/,"ws")}?room=${room}&client=${clientId}`);socket=ws;
  $("#roomCode").textContent=room;$("#status").textContent="连接中";$("#status").classList.remove("online");
  ws.onopen=()=>{if(id!==connectionId)return;retryDelay=1000;$("#status").textContent="已连接";$("#status").classList.add("online");$("#share").disabled=false;send({type:"request-state"})};
  ws.onmessage=async({data})=>{if(id!==connectionId)return;const m=JSON.parse(data);if(m.sender===clientId||m.type==="heartbeat")return;if(m.type==="request-state")return send({type:"state",state:snapshot()});if(m.type!=="state")return;const s=m.state;if(s.episode&&s.episode.audio!==episode?.audio)showEpisode(s.episode);if(!s.episode)return;applying=true;const target=s.currentTime+(s.paused?0:Math.max(0,(Date.now()-m.sentAt)/1000));if(Math.abs(audio.currentTime-target)>.7)audio.currentTime=target;audio.playbackRate=s.playbackRate||1;try{s.paused?audio.pause():await audio.play()}catch{toast("点一下播放键即可开始同步")}setTimeout(()=>applying=false,250)};
  ws.onclose=()=>{if(id!==connectionId)return;$("#status").textContent="连接中断";$("#status").classList.remove("online");reconnectTimer=setTimeout(()=>connect(room),retryDelay);retryDelay=Math.min(retryDelay*2,10000)};
  ws.onerror=()=>ws.close();
}
function publish(){if(applying||Date.now()-lastSent<250)return;lastSent=Date.now();send({type:"state",state:snapshot()})}
$("#load").onclick=()=>loadEpisode();$("#episodeUrl").onkeydown=e=>{if(e.key==="Enter")loadEpisode()};
$("#create").onclick=()=>{if(!episode)return toast("请先载入一集播客");connect(Math.random().toString(36).slice(2,8).toUpperCase())};
$("#share").onclick=copyInvite;$("#copy").onclick=copyInvite;
for(const event of ["play","pause","seeked","ratechange"])audio.addEventListener(event,publish);setInterval(()=>{if(!audio.paused)publish()},5000);setInterval(()=>send({type:"heartbeat"}),15000);document.addEventListener("visibilitychange",()=>{if(!document.hidden&&room&&socket?.readyState!==1)connect(room)});if(room)connect(room);
