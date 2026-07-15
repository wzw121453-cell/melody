const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT || 8787);
const rooms = new Map();
const publicDir = path.join(__dirname, "public");
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml" };

function decode(value = "") {
  return value.replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
}

function hash(value) { return crypto.createHash("sha256").update(value).digest("hex"); }
function readJson(req) { return new Promise((resolve, reject) => { let body=""; req.on("data",c=>{ body+=c; if(body.length>4096) reject(new Error("请求过大")); }); req.on("end",()=>{ try{ resolve(JSON.parse(body||"{}")); }catch{ reject(new Error("格式错误")); } }); }); }

function meta(html, property) {
  const escaped = property.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name)=["']${escaped}["'][^>]+content=["']([^"']+)["']`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${escaped}["']`, "i"),
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decode(match[1]);
  }
  return "";
}

function podcastSchema(html){
  const scripts=[...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)];
  function find(value){
    if(!value||typeof value!=="object")return null;
    if(value["@type"]==="PodcastEpisode"||(Array.isArray(value["@type"])&&value["@type"].includes("PodcastEpisode")))return value;
    for(const child of Object.values(value)){const found=find(child);if(found)return found}
    return null;
  }
  for(const match of scripts){try{const found=find(JSON.parse(decode(match[1])));if(found)return found}catch{}}
  return {};
}

function plainDescription(value=""){
  return decode(String(value))
    .replace(/<br\s*\/?\s*>/gi,"\n").replace(/<\/(?:p|div|li|h[1-6]|figure)>/gi,"\n")
    .replace(/<li[^>]*>/gi,"• ").replace(/<img[^>]+alt=["']([^"']+)["'][^>]*>/gi,"\n$1\n")
    .replace(/<[^>]+>/g,"").replace(/\u00a0/g," ").replace(/[ \t]+\n/g,"\n")
    .replace(/\n{3,}/g,"\n\n").trim();
}

function nextDataDescription(html,targetTitle=""){
  const match=html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);if(!match)return "";
  let root;try{root=JSON.parse(decode(match[1]))}catch{return ""}
  const keys=["shownotes","showNotes","description","summary","intro","brief","content"],candidates=[];
  function walk(value,depth=0){if(!value||depth>12)return;if(Array.isArray(value)){for(const item of value)walk(item,depth+1);return}if(typeof value!=="object")return;
    const objectTitle=String(value.title||value.name||value.episodeTitle||"");const titleMatch=targetTitle&&objectTitle&&(objectTitle.includes(targetTitle)||targetTitle.includes(objectTitle));
    for(const key of keys){const text=value[key];if(typeof text==="string"&&text.trim().length>30){let score=Math.min(text.length,100);if(key.toLowerCase().includes("shownote"))score+=180;if(titleMatch)score+=300;if(value.audio||value.audioUrl||value.enclosure||value.media)score+=80;candidates.push({text,score})}}
    for(const child of Object.values(value))if(typeof child==="object")walk(child,depth+1)
  }walk(root);candidates.sort((a,b)=>b.score-a.score);return candidates[0]?.text||"";
}

async function episodeInfo(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("分享链接格式不正确"); }
  if (!(url.hostname === "xiaoyuzhoufm.com" || url.hostname.endsWith(".xiaoyuzhoufm.com"))) throw new Error("仅支持小宇宙分享链接");
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 ListenTogether/1.0" } });
  if (!response.ok) throw new Error("无法读取这个分享链接");
  const html = await response.text();
  const schema=podcastSchema(html);
  const title=meta(html, "og:title") || schema.name || "小宇宙播客";
  const audio = meta(html, "og:audio") || schema.associatedMedia?.contentUrl || html.match(/"contentUrl"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u0026/g, "&");
  if (!audio) throw new Error("该单集没有可公开播放的音频，付费内容暂不支持");
  const description=plainDescription(schema.description||nextDataDescription(html,title)||meta(html,"description")||"");
  return { title, podcast:schema.partOfSeries?.name||meta(html, "og:description").split("\n")[0].replace(/^听《|》上小宇宙.*$/g, ""), image: meta(html, "og:image"), audio, description, source: response.url };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname === "/api/rooms" && req.method === "POST") {
    try {
      const body=await readJson(req), password=String(body.password||"").slice(0,24);
      let room; do { room=crypto.randomBytes(3).toString("hex").toUpperCase(); } while(rooms.has(room));
      const hostToken=crypto.randomBytes(24).toString("hex");
      rooms.set(room,{members:new Set(),hostToken,passwordHash:password?hash(password):"",chats:[],state:null,createdAt:Date.now()});
      res.writeHead(201,{"content-type":"application/json; charset=utf-8"}); return res.end(JSON.stringify({room,hostToken,hasPassword:!!password}));
    } catch(error) { res.writeHead(400,{"content-type":"application/json; charset=utf-8"}); return res.end(JSON.stringify({error:error.message})); }
  }
  if (requestUrl.pathname === "/api/episode") {
    try {
      const info = await episodeInfo(requestUrl.searchParams.get("url") || "");
      res.writeHead(200, { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=3600" });
      return res.end(JSON.stringify(info));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json; charset=utf-8" });
      return res.end(JSON.stringify({ error: error.message }));
    }
  }
  if (requestUrl.pathname === "/health") {
    res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
    return res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
  }
  const requested = requestUrl.pathname === "/" ? "index.html" : requestUrl.pathname.slice(1);
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); return res.end("Not found");
  }
  res.writeHead(200, { "content-type": mime[path.extname(filePath)] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
});

const wss = new WebSocketServer({ server });
wss.on("connection", (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = (url.searchParams.get("room") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  if (!room || !rooms.has(room)) return socket.close(4004, "房间不存在或已过期");
  const data=rooms.get(room), token=url.searchParams.get("token")||"", password=url.searchParams.get("password")||"";
  const isHost=token&&token===data.hostToken;
  const userId=(url.searchParams.get("client")||"").slice(0,80), name=(url.searchParams.get("name")||"房友").trim().slice(0,12)||"房友";
  if(!isHost&&data.passwordHash&&hash(password)!==data.passwordHash) return socket.close(4003,"房间密码错误");
  const members = data.members;
  socket.user={userId,name,isHost};
  for(const member of members){
    if(member.user?.userId===userId){member.close(4000,"已在新页面连接");members.delete(member)}
  }
  members.add(socket);
  const presence=()=>[...members].map(member=>member.user);
  socket.send(JSON.stringify({type:"welcome",isHost,memberCount:members.size,members:presence(),chats:data.chats,state:data.state}));
  for(const member of members) if(member.readyState===WebSocket.OPEN) member.send(JSON.stringify({type:"members",memberCount:members.size,members:presence()}));
  socket.on("message", raw => {
    if (raw.length > 8192) return;
    let message; try{message=JSON.parse(raw.toString())}catch{return}
    if(message.type==="chat"){
      const text=String(message.text||"").trim().slice(0,80); if(!text)return;
      message={type:"chat",id:crypto.randomUUID(),text,sender:userId,name,isHost,sentAt:Date.now()};
      data.chats.push(message); if(data.chats.length>50)data.chats.shift();
    }
    if(message.type==="state")data.state={...message,sender:userId,sentAt:Date.now()};
    const encoded=JSON.stringify(message); for (const member of members) if (member.readyState === WebSocket.OPEN) member.send(encoded);
  });
  socket.on("close", () => { members.delete(socket); for(const member of members) if(member.readyState===WebSocket.OPEN) member.send(JSON.stringify({type:"members",memberCount:members.size,members:presence()})); });
});

setInterval(()=>{const now=Date.now();for(const [id,data] of rooms)if(!data.members.size&&now-data.createdAt>6*60*60*1000)rooms.delete(id)},30*60*1000).unref();

server.listen(port, () => console.log(`Listen Together server: http://localhost:${port}`));
