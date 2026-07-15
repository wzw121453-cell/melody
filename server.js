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

async function episodeInfo(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { throw new Error("分享链接格式不正确"); }
  if (!(url.hostname === "xiaoyuzhoufm.com" || url.hostname.endsWith(".xiaoyuzhoufm.com"))) throw new Error("仅支持小宇宙分享链接");
  const response = await fetch(url, { redirect: "follow", headers: { "user-agent": "Mozilla/5.0 ListenTogether/1.0" } });
  if (!response.ok) throw new Error("无法读取这个分享链接");
  const html = await response.text();
  const audio = meta(html, "og:audio") || html.match(/"contentUrl"\s*:\s*"([^"]+)"/)?.[1]?.replace(/\\u0026/g, "&");
  if (!audio) throw new Error("该单集没有可公开播放的音频，付费内容暂不支持");
  return { title: meta(html, "og:title") || "小宇宙播客", podcast: meta(html, "og:description").split("\n")[0].replace(/^听《|》上小宇宙.*$/g, ""), image: meta(html, "og:image"), audio, source: response.url };
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  if (requestUrl.pathname === "/api/rooms" && req.method === "POST") {
    try {
      const body=await readJson(req), password=String(body.password||"").slice(0,24);
      let room; do { room=crypto.randomBytes(3).toString("hex").toUpperCase(); } while(rooms.has(room));
      const hostToken=crypto.randomBytes(24).toString("hex");
      rooms.set(room,{members:new Set(),hostToken,passwordHash:password?hash(password):"",chats:[],createdAt:Date.now()});
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
  if(!isHost&&data.passwordHash&&hash(password)!==data.passwordHash) return socket.close(4003,"房间密码错误");
  const members = data.members;
  members.add(socket);
  socket.send(JSON.stringify({type:"welcome",isHost,memberCount:members.size,chats:data.chats}));
  for(const member of members) if(member.readyState===WebSocket.OPEN) member.send(JSON.stringify({type:"members",memberCount:members.size}));
  socket.on("message", raw => {
    if (raw.length > 8192) return;
    let message; try{message=JSON.parse(raw.toString())}catch{return}
    if(message.type==="chat"){
      const text=String(message.text||"").trim().slice(0,80); if(!text)return;
      message={type:"chat",text,sender:String(message.sender||"").slice(0,80),name:String(message.name||"房友").slice(0,12),sentAt:Date.now()};
      data.chats.push(message); if(data.chats.length>50)data.chats.shift();
    }
    const encoded=JSON.stringify(message); for (const member of members) if (member.readyState === WebSocket.OPEN) member.send(encoded);
  });
  socket.on("close", () => { members.delete(socket); for(const member of members) if(member.readyState===WebSocket.OPEN) member.send(JSON.stringify({type:"members",memberCount:members.size})); });
});

setInterval(()=>{const now=Date.now();for(const [id,data] of rooms)if(!data.members.size&&now-data.createdAt>6*60*60*1000)rooms.delete(id)},30*60*1000).unref();

server.listen(port, () => console.log(`Listen Together server: http://localhost:${port}`));
