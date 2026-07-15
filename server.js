const http = require("http");
const { WebSocketServer, WebSocket } = require("ws");

const port = Number(process.env.PORT || 8787);
const rooms = new Map();
const server = http.createServer((req, res) => {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify({ ok: true, rooms: rooms.size }));
});
const wss = new WebSocketServer({ server });

wss.on("connection", (socket, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const room = (url.searchParams.get("room") || "").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 24);
  if (!room) return socket.close(1008, "Room is required");
  if (!rooms.has(room)) rooms.set(room, new Set());
  const members = rooms.get(room);
  members.add(socket);

  socket.on("message", (raw) => {
    if (raw.length > 4096) return;
    for (const member of members) {
      if (member.readyState === WebSocket.OPEN) member.send(raw.toString());
    }
  });
  socket.on("close", () => {
    members.delete(socket);
    if (!members.size) rooms.delete(room);
  });
});

server.listen(port, () => console.log(`Listen Together server: ws://localhost:${port}`));
