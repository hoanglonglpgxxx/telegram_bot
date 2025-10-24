// ===============================
//  Socket.IO Chat Server (Redis Adapter - Redis v5+)
// ===============================

const fs = require('fs');
const express = require('express');
const http = require('http');
const https = require('https');
const socketio = require('socket.io');
const { createClient } = require('redis');
const { createAdapter } = require('@socket.io/redis-adapter');
const os = require('os');
const { debug, log } = require('console');
// --- Utils ---
function getLocalIP() {
    const interfaces = os.networkInterfaces();
    for (const name in interfaces) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return '0.0.0.0';
}

function formatDateTime(dateObj) {
    const pad = (number) => String(number).padStart(2, '0');
    const Y = dateObj.getFullYear();
    const m = pad(dateObj.getMonth() + 1);
    const d = pad(dateObj.getDate());
    const H = pad(dateObj.getHours());
    const i = pad(dateObj.getMinutes());
    const s = pad(dateObj.getSeconds());
    return `${Y}-${m}-${d} ${H}:${i}:${s}`;
}

function debugLog(...args) {
    const now = new Date();
    const formattedString = formatDateTime(now);
    const prefix = `[${formattedString}] [${os.hostname()}]`;
    console.log(prefix, ...args);
}
// --- Config ---
const config = {
    // REDIS CONFIG
    // Lấy từ biến môi trường, nếu không tồn tại thì dùng giá trị mặc định (fallback)
    redisHost: process.env.REDIS_HOST || "",
    redisPort: process.env.REDIS_PORT || 0,
    redisPassword: process.env.REDIS_PASSWORD || "",

    // SSL CONFIG
    // Lấy từ biến môi trường, nếu không tồn tại thì dùng đường dẫn hardcode cũ làm mặc định
    sslKey: process.env.SSL_KEY_PATH || "",
    sslCert: process.env.SSL_CERT_PATH || "",

    // PORT (Giữ nguyên)
    port: process.env.PORT || 0
};

if (!config.redisHost || config.redisPort === 0 || !config.redisPassword) {
    debugLog("ERROR: Missing required Redis configuration (REDIS_HOST, REDIS_PORT, or REDIS_PASSWORD). Exiting.");
    process.exit(1);
} else {
    debugLog(`Redis config: ${JSON.stringify(config)}`);
}




// --- Server setup ---
const app = express();
app.use(express.json());
let server;

// Xử lý HTTPS/HTTP
try {
    if (fs.existsSync(config.sslKey) && fs.existsSync(config.sslCert)) {
        const options = {
            key: fs.readFileSync(config.sslKey),
            cert: fs.readFileSync(config.sslCert)
        };
        server = https.createServer(options, app);
        debugLog("Running in HTTPS mode");
    } else {
        throw new Error("SSL files not found");
    }
} catch (err) {
    debugLog("SSL not found or invalid, fallback to HTTP:", err.message);
    server = http.createServer(app);
}

// --- Socket.IO và Redis setup ---
let io; // Khai báo io ở phạm vi global

async function initRedis() {
    try {
        const redisUrl = `redis://default:${config.redisPassword}@${config.redisHost}:${config.redisPort}`;
        // Định nghĩa cấu hình Keepalive (ví dụ: gửi gói tin mỗi 60 giây)
        const clientOptions = {
            url: redisUrl,
            socket: {
                keepAlive: 60000 // Gửi gói tin keep-alive mỗi 60 giây (60000ms)
            }
        };
        const pubClient = createClient(clientOptions);
        const subClient = pubClient.duplicate();

        const PING_INTERVAL_MS = 240000; // 4 phút
        setInterval(async () => {
            if (pubClient.isOpen) {
                try {
                    // Gửi lệnh PING nhẹ nhàng
                    await pubClient.ping();
                    debugLog('Sent periodic PING to Redis to keep connection alive.');
                } catch (e) {
                    // Nếu PING thất bại, client sẽ tự cố gắng tái kết nối
                    debugLog('Periodic PING failed, connection may be resetting:', e.message);
                }
            }
        }, PING_INTERVAL_MS);

        pubClient.on('error', (err) => debugLog('Redis pubClient error:', err));
        subClient.on('error', (err) => debugLog('Redis subClient error:', err));
        pubClient.on('connect', () => debugLog('Redis pubClient connected'));
        subClient.on('connect', () => debugLog('Redis subClient connected'));

        await pubClient.connect();
        await subClient.connect();

        // --- SỬA CHỮA QUAN TRỌNG: Gán Key tường minh và Adapter ngay lúc khởi tạo io ---
        // Sử dụng key bạn đã thấy trong log `psubscribe`
        const adapter = createAdapter(pubClient, subClient, { key: 'vsystem_chat_bus' });

        io = socketio(server, {
            cors: { origin: "*" },
            adapter: adapter,
            allowEIO3: true,
            transports: ['polling', 'websocket']
        });

        debugLog('Connected to Redis adapter with key: vsystem_chat_bus');

        // Log nhận tin nhắn qua Redis (Nếu thấy log này thì việc đồng bộ đã thành công)
        io.of("/").adapter.on("message", (channel, message) => {
            debugLog("Redis message received:", channel, message);
        });

        return io;

    } catch (err) {
        console.error('Redis connection failed:', err.message);
    }
}

// --- Khởi tạo Redis và start server sau khi kết nối xong ---
initRedis().then((ioInstance) => {
    if (ioInstance) {
        // -- Add users vào room --
        app.post('/internal/add-users-to-room', (req, res) => {
            try {
                const { roomId, users, roomName } = req.body;

                if (!roomId || !users || !Array.isArray(users)) {
                    debugLog('API /add-users: Invalid request body', req.body);
                    return res.status(400).json({ error: 'Invalid request body' });
                }

                // 1. Join các socket của user vào room
                ioInstance.in(users).socketsJoin(roomId);

                // 2. Gửi sự kiện 'added_to_room' TỚI CÁC USER ĐÓ
                // (Gửi tới phòng cá nhân của họ)
                ioInstance.to(users).emit('added_to_room', {
                    roomId: roomId,
                    roomName: roomName || 'New Room'
                });

                debugLog(`API /add-users: Successfully added users ${users} to room ${roomId}`);
                res.json({ success: true, joined: users, room: roomId });

            } catch (error) {
                debugLog('API /add-users: Error:', error.message);
                res.status(500).json({ error: 'Internal server error' });
            }
        });

        // --- Socket.IO handlers ---
        ioInstance.on('connection', (socket) => {
            debugLog(`longlh| Client ${socket.id} connected from ${socket.handshake.address}`);

            const userId = socket.handshake.auth.userId;

            if (userId) {
                console.log(`longlh | User ${userId} connected with socket ${socket.id}`);
                socket.join(userId.toString());

                socket.on('joinRooms', (data) => {
                    const roomsToJoin = data.rooms || [];

                    if (Array.isArray(roomsToJoin) && roomsToJoin.length > 0) {
                        socket.join(roomsToJoin);
                        debugLog(`longlh | User ${userId} joined rooms:`, roomsToJoin);
                    }
                });

                socket.on('privateMsg', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('newMsg', messagePayload);
                    // ioInstance.to(senderId.toString()).emit('newMsg', messagePayload);
                    //recipientId này là roomId luôn
                    debugLog(`longlh | send msg '${data.content}' from ${senderId} type:private to room '${roomId}'`);
                });

                socket.on('addLabel', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('newMsg', messagePayload);
                    debugLog(`longlh | add label '${data.content}' from ${senderId} type:private to room '${roomId}'`);
                });

                socket.on('deleteMsg', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('deleteMsg', messagePayload);
                    debugLog(`longlh | delete msg '${data.msgId}' from ${senderId} type:private to room '${roomId}'`);
                });

                socket.on('typing', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('typing', messagePayload);
                    debugLog(`longlh | ${data.total} typing msg '${data.msgId}' sender ${senderId} included type:private to room '${roomId}'`);
                });
                socket.on('stopTyping', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('stopTyping', messagePayload);
                    debugLog(`longlh | ${data.total} typing msg '${data.msgId}' sender ${senderId} included type:private to room '${roomId}'`);
                });
                socket.on('deleteMulti', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('deleteMulti', messagePayload);
                    debugLog(`longlh | delete msgs '${data.msgArr}' from ${senderId} type:private to room '${roomId}'`);
                });
                socket.on('editMsg', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('editMsg', messagePayload);
                    debugLog(`longlh | edit msg '${data.msgArr}' from ${senderId} type:private to room '${roomId}'`);
                });
                socket.on('pinMsg', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('editMsg', messagePayload);
                    debugLog(`longlh | pin msg '${data.msgId}' from ${senderId} type:private to room '${roomId}'`);
                });
                socket.on('reactMsg', async (data) => {
                    const senderId = socket.handshake.auth.userId;
                    if (!data.roomId) return;
                    const roomId = `group:${data.roomId}`;

                    const messagePayload = {
                        ...data,
                        senderId,
                        roomId,
                        createdTime: Date.now()
                    };

                    ioInstance.to(roomId).emit('reactMsg', messagePayload);
                    debugLog(`longlh | react msg '${data.msgId}' from ${senderId} type:private to room '${roomId}'`);
                });
            } else {
                socket.on('room', (room) => {
                    socket.room = room;
                    // Lọc bỏ các giá trị rỗng hoặc khoảng trắng
                    const rooms = room.split(',').filter(r => r.trim() !== '');
                    if (rooms.length > 0) {
                        socket.join(rooms);
                        debugLog(socket.id + " joined room(s):", room, `|| rooms list ${rooms}`);
                    }
                });

                const events = ['comments message', 'videochat', 'command'];
                for (const eventName of events) {
                    socket.on(eventName, (data) => {
                        debugLog(`Received event '${eventName}' from ${socket.id}`);

                        const targetRoom = data.room ? data.room : socket.room;

                        if (targetRoom) {
                            // Lệnh này kích hoạt PUBLISH qua Adapter, gửi tới phòng TRỪ người gửi.
                            socket.to(targetRoom).emit(eventName, data);
                            debugLog(`Broadcasting event '${eventName}' to room '${targetRoom}' (excluding sender)`);
                        } else {
                            // Fallback: Gửi toàn cầu nếu không có room (cũng kích hoạt PUBLISH)
                            ioInstance.emit(eventName, data);
                            debugLog(`Broadcasting event '${eventName}' globally (NO ROOM)`);
                        }
                    });
                }
            }

            socket.on('disconnect', () => {
                debugLog(`Detect client disconnected: ${socket.id}`);
            });
        });

        const ip = getLocalIP();
        server.listen(config.port, "0.0.0.0", () => {
            debugLog(`Server listening on https://${ip}:${config.port}`);
        });
    }
});

// --- Serve static files (optional) ---
app.use(express.static(__dirname + '/public'));