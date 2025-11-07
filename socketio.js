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

function debugLog(ipAddress, ...args) {
    const now = new Date();
    const formattedString = formatDateTime(now);
    const prefix = `[${formattedString}] [${os.hostname()}] [${ipAddress || 'NO_ADDR'}]`;
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
    secretKey: process.env.SECRET_KEY_PATH || "",

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

let APP_SECRET_KEY = '';
try {
    APP_SECRET_KEY = fs.readFileSync(config.secretKey, 'utf8');
    debugLog('Successfully loaded secret key.');
} catch (err) {
    debugLog('FATAL ERROR: Could not read secretKey.', err.message);
}

// --- Socket.IO và Redis setup ---
let io; // Khai báo io ở phạm vi global
let pubClient;
let subClient;
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
        pubClient = createClient(clientOptions);
        subClient = pubClient.duplicate();

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

async function getCurrentUsersInRoom(roomName) {
    const sockets = await io.in(roomName).fetchSockets();

    const userIds = sockets.map(socket => socket.handshake.auth.userId || '');

    return userIds;
}

async function getUsersList(roomId, memberIds) {
    const currentUsers = await getCurrentUsersInRoom(roomId);
    let notJoinedRoomUsers = memberIds.filter(e => {
        if (!currentUsers.includes(e)) return e;
    });
    return { currentUsers, notJoinedRoomUsers };
}

async function getJson(params = {}, timeout = 2000) {
    let url = `http://localhost/api/Member/ChatRoom/select`;
    // let url = `http://localhost/api/Extra/Chat/Account/ChatRoom/select`;
    const u = new URL(url);
    Object.entries(params).forEach(([k, v]) => u.searchParams.append(k, String(v)));
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeout);

    try {
        const res = await fetch(u.toString(), {
            method: 'GET',
            headers: { 'Accept': 'application/json' },
            signal: controller.signal
        });

        clearTimeout(id);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status} ${res.statusText}: ${text}`);
        }

        return await res.json();
    } catch (err) {
        if (err.name === 'AbortError') throw new Error('Request timed out');
        throw err;
    }
}

function checkRequestValidStatus(eventName, data) {
    const SECRET_EVENTS = [
        'newMsg',
        'addLabel',
        'deleteMsg',
        'pinMsg',
        'deleteMulti',
        'editMsg',
        'reactMsg',
        'editRoom',
        'changeRoomTitle',
        'changeRoomAvatar',
        'isBeingHandled',
        'addUsersToRoom'];
    let currentTimeStamp = Date.now(),
        exceedTime = Math.abs(currentTimeStamp - data.lastUpdateTime) / 1000;

    if (SECRET_EVENTS.includes(eventName) && data.secretKey == APP_SECRET_KEY && exceedTime <= 10) return true;
    else if (!SECRET_EVENTS.includes(eventName)) return true;
    else {
        debugLog(source, `Event ${eventName} is blocked cause called from unauthorized source`);
        return false;
    }
}

// --- Khởi tạo Redis và start server sau khi kết nối xong ---
initRedis().then((ioInstance) => {

    /* async function handleTypingState(payload, eventName) {
        const typingKey = `typing:${payload.roomId}`;
        const userInfoKey = `userinfo:${payload.roomId}`;

        const multi = pubClient.multi();

        if (eventName === 'userTyping') {
            const userDetails = JSON.stringify({
                id: payload.senderId,
                name: payload.senderName
            });
            // add all command vào pipeline
            multi.sAdd(typingKey, payload.senderId);
            multi.expire(typingKey, 1);
            multi.hSet(userInfoKey, payload.senderId, userDetails);
            multi.expire(userInfoKey, 1);
        } else if (eventName === 'userStopTyping') {
            multi.sRem(typingKey, payload.senderId);
        }

        // gửi all command đến redis 1 lần
        await multi.exec();

        const typingUserIds = await pubClient.sMembers(typingKey);

        let typingUsersWithDetails = [];
        if (typingUserIds.length > 0) {
            const userDetailsList = await pubClient.hmGet(userInfoKey, typingUserIds);
            typingUsersWithDetails = userDetailsList
                .filter(details => details)
                .map(details => JSON.parse(details));
        }

        payload.typingUsers = typingUsersWithDetails;

        debugLog(`Processed '${eventName}' with typing users are '${JSON.stringify(payload.typingUsers) || []}'`);
        return payload;
    } */

    async function processAndBroadcast(socket, ioInstance, eventName, data, options = {}) {
        const userId = socket.handshake.auth.userId;
        const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

        if (!data.roomId) {
            debugLog(clientIp, `Event '${eventName}' dropped: No roomId provided.`);
            return;
        }

        // if (!checkRequestValidStatus(eventName, data)) return;

        const fullRoomId = `group:${data.roomId}`;
        let roomData = {};

        if (options.fetchRoomData) {
            try {
                roomData = await getJson({ id: data.roomId });
            } catch (e) {
                debugLog(clientIp, `GET ROOM DATA FAILED | ${e.message}`);
            }
        }

        let payload = {
            ...data,
            senderId: userId,
            roomId: fullRoomId,
            createdTime: Date.now()
        };

        if (options.beforeEmit && typeof options.beforeEmit === 'function') {
            payload = await options.beforeEmit(payload, eventName);
        }

        if (Object.keys(roomData).length) {
            payload.roomData = roomData;
        }

        if (options.ignoreSender) {
            socket.to(fullRoomId).emit(eventName, payload);
        } else if (options.senderOnly) {
            socket.emit(eventName, payload);
        } else {
            ioInstance.to(fullRoomId).emit(eventName, payload);
        }

        if (options.notifyOutsiders && data.memberIds) {
            const { notJoinedRoomUsers } = await getUsersList(fullRoomId, data.memberIds);

            const outsiderEvent = options.outsiderEventName || 'roomUpdated';
            payload['eventType'] = 'private'; //cờ gắn riêng cho event bắn cho room dạng user:userId
            notJoinedRoomUsers.forEach(user => {
                ioInstance.to(`user:${user}`).emit(outsiderEvent, payload);
            });
        }

        debugLog(clientIp, `Processed and broadcasted '${eventName}' from ${userId} to room '${fullRoomId}'`);
    }

    if (ioInstance) {
        // --- Socket.IO handlers ---
        ioInstance.on('connection', (socket) => {
            const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
            /* đoạn này để debug in ra socket
            function circularReplacer() {
                const seen = new WeakSet();
                return (key, value) => {
                    if (typeof value === "object" && value !== null) {
                        if (seen.has(value)) {
                            return; // Omit circular references
                        }
                        seen.add(value);
                    }
                    return value;
                };
            }

            socket.parent = socket;
            const jsonString = JSON.stringify(socket, circularReplacer()); */
            debugLog(clientIp, `longlh| Client ${socket.id} connected`);

            const userId = socket.handshake.auth.userId;

            if (userId) {
                socket.join(`user:${userId}`);

                socket.on('joinRoom', async (data) => {
                    const { roomId, memberIds } = data;
                    if (!roomId || !Array.isArray(memberIds)) {
                        debugLog(`longlh JOINROOM | Missing params (roomId or memberIds is invalid)`);
                        return;
                    }

                    //check userId có được allow, k bị block, chưa join room
                    const currentUsers = await getCurrentUsersInRoom(roomId);
                    if (memberIds.includes(userId)
                        && !currentUsers.includes(userId)) {
                        socket.join(roomId);

                        const joinedRooms = Array.from(socket.rooms).filter(room => room !== socket.id);
                        if (joinedRooms.length) {
                            joinedRooms.forEach(curRoomName => {
                                if (curRoomName.includes('group') && curRoomName !== roomId) socket.leave(curRoomName);
                            });
                        }

                        debugLog(clientIp, `longlh JOINROOM | User ${userId} joined ${roomId} || currentUserInRoom: ${currentUsers} || memberIds: ${memberIds} || joinedRoom: ${joinedRooms} || after remove Rooms: ${Array.from(socket.rooms).filter(room => room !== socket.id)}`);
                        /*  //cần check nếu là admin ở đây, lấy từ select room
 
                         let admins = [];
                         if (admins.includes(userId)) {
                             debugLog(clientIp, `longlh An admin has joined the room ${roomId}`);
                             ioInstance.to(roomId).emit('adminJoined', {});
                         } */
                    } else if (currentUsers.includes(userId)) {
                        debugLog(clientIp, `longlh | User ${userId} is in room ${roomId} already`);
                    }
                    else {
                        debugLog(clientIp, `longlh | User ${userId} was blocked or not in by ${roomId} with memberIds ${memberIds}`);
                    }
                });

                const sendMsgOptions = {
                    fetchRoomData: false,
                    notifyOutsiders: true,
                    outsiderEventName: 'roomUpdated',
                    ignoreSender: false,
                    senderOnly: false,
                    beforeEmit: false,
                };

                socket.on('newMsg', async (data) => processAndBroadcast(socket, ioInstance, 'newMsg', data, sendMsgOptions));

                socket.on('addTag', (data) => processAndBroadcast(socket, ioInstance, 'addTag', data));

                socket.on('deleteMsg', (data) => processAndBroadcast(socket, ioInstance, 'deleteMsg', data, {
                    notifyOutsiders: true,
                    outsiderEventName: 'deleteMsg'
                }));

                socket.on('pinMsg', (data) => processAndBroadcast(socket, ioInstance, 'pinMsg', data, {
                    notifyOutsiders: true,
                    outsiderEventName: 'pinMsg'
                }));

                socket.on('userTyping', (data) => processAndBroadcast(socket, ioInstance, 'userTyping', data, {
                    ignoreSender: true,
                    // beforeEmit: handleTypingState,
                }));

                socket.on('userStopTyping', (data) => processAndBroadcast(socket, ioInstance, 'userStopTyping', data, {
                    ignoreSender: true,
                }));

                socket.on('editMsg', (data) => processAndBroadcast(socket, ioInstance, 'editMsg', data, {
                    notifyOutsiders: true,
                    outsiderEventName: 'editMsg'
                }));

                socket.on('reactMsg', (data) => processAndBroadcast(socket, ioInstance, 'reactMsg', data));

                socket.on('pinRoom', (data) => processAndBroadcast(socket, ioInstance, 'pinRoom', data, {
                    senderOnly: true
                }));

                socket.on('editRoom', (data) => processAndBroadcast(socket, ioInstance, 'editRoom', data, {
                    notifyOutsiders: true,
                    outsiderEventName: 'editRoom'
                }));

                socket.on('notifyConfig', (data) => processAndBroadcast(socket, ioInstance, 'notifyConfig', data, {
                    senderOnly: true
                }));
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
                debugLog(`Detect client disconnected: ${socket?.id}`);
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