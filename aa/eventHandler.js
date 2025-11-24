// eventHandler.js
const crypto = require('crypto');
const { APP_SECRET_KEY } = require('./config');
const { debugLog } = require('./utils.js');
const EVENT_CHAT_CHANNEL = 'vsystem_chat_event';
const NONCE_TTL_SECONDS = 60;
const MAX_TIME_DIFF_SECONDS = 60;
const ALLOWED_EVENTS = ['newMsg', 'userTyping', 'userStopTyping', 'deleteMsg', 'pinMsg', 'editMsg', 'reactMsg', 'addTag', 'roomUpdated', 'notifyConfig', 'editRoom', 'pinRoom', 'joinRoom'];
/**
 * Hàm chuẩn hóa payload để tạo chuỗi dữ liệu ký.
 * @param {object} data - Dữ liệu đã được loại bỏ signature.
 * @returns {string} Chuỗi JSON đã được chuẩn hóa.
 */
function canonicalizePayload(data) {
    try {
        return JSON.stringify(data);
    } catch (e) {
        debugLog("Canonicalization failed:", e.message);
        return "";
    }
}

/**
 * Hàm kiểm tra Nonce (số chỉ dùng một lần) trong Redis để chống Replay Attack.
 * @param {object} pubClient - Redis client (Pub) dùng để ghi/đọc.
 * @param {string} nonce - Nonce được gửi từ PHP.
 * @returns {Promise<boolean>} Trả về TRUE nếu Nonce đã được sử dụng (Replay Attack), FALSE nếu Nonce mới.
 */
async function isNonceUsed(pubClient, nonce) {
    const NONCE_KEY = `chat:nonce:${nonce}`;
    const result = await pubClient.set(NONCE_KEY, '1', {
        NX: true,
        EX: NONCE_TTL_SECONDS
    });
    return result === null;
}

function sortObject(obj) {
    if (Array.isArray(obj)) {
        return obj.map(sortObject);
    }
    if (obj !== null && typeof obj === 'object') {
        return Object.keys(obj)
            .sort()
            .reduce((sorted, key) => {
                sorted[key] = sortObject(obj[key]);
                return sorted;
            }, {});
    }
    return obj;
}

/**
 * Hàm xác minh chữ ký HMAC-SHA256.
 * @param {object} payload - Toàn bộ tin nhắn nhận được.
 * @param {string} receivedSignature - Chữ ký đính kèm.
 * @param {string} secret - Khóa bí mật chia sẻ.
 * @returns {boolean} Kết quả xác minh.
 */
function verifyHMAC(payload, receivedSignature, secret) {
    let dataToVerify;

    if (typeof payload === 'string') {
        dataToVerify = JSON.parse(payload);
    } else {
        dataToVerify = { ...payload };
    }
    debugLog('cur payload ', payload, receivedSignature, secret);
    if (dataToVerify.signature) {
        delete dataToVerify.signature;
    }
    const sortedData = sortObject(dataToVerify);
    let canonicalString = JSON.stringify(sortedData);
    canonicalString = canonicalString.replace(/\//g, '\\/');
    const expectedSignature = crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
    try {
        debugLog('handled crypto', canonicalString, expectedSignature, crypto.timingSafeEqual(Buffer.from(receivedSignature, 'hex'), Buffer.from(expectedSignature, 'hex')));
        return crypto.timingSafeEqual(Buffer.from(receivedSignature, 'hex'), Buffer.from(expectedSignature, 'hex'));
    } catch (e) {
        debugLog("TimingSafeEqual failed:", e.message);
        return false;
    }
}

function debugSocketInfo(socket) {
    if (!socket) return;

    const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

    console.log(`\n--- 🕵️ DEBUG SOCKET [${socket.id}] ---`);
    console.log(`IP: ${clientIp}`);

    // 1. Kiểm tra AUTH (Nơi chứa userId chuẩn của Socket.IO v4)
    console.log(`👉 handshake.auth:`, JSON.stringify(socket.handshake.auth, null, 2));

    // 2. Kiểm tra QUERY (Nếu client gửi qua URL ?userId=...)
    console.log(`👉 handshake.query:`, JSON.stringify(socket.handshake.query, null, 2));

    // 3. Kiểm tra ROOMS (Xem socket này đang ở đâu)
    // Lưu ý: Phải dùng Array.from() vì nó là Set
    console.log(`👉 rooms:`, JSON.stringify(Array.from(socket.rooms)));

    // 4. Kiểm tra HEADERS (Nếu client gửi qua Header custom)
    // In gọn lại để dễ nhìn
    const h = socket.handshake.headers;
    console.log(`👉 headers (chọn lọc):`, JSON.stringify({
        'userid': h['userid'],       // Check header thường gặp
        'user-id': h['user-id'],     // Check biến thể
        'cookie': h['cookie'] ? 'Has Cookie' : 'No Cookie',
        'user-agent': h['user-agent']
    }, null, 2));
    console.log(`------------------------------------------\n`);
}


/**
 * Khởi tạo việc lắng nghe kênh Redis riêng và xử lý logic bảo mật.
 * @param {object} io - instance của Socket.IO
 * @param {object} pubClient - Redis Client dùng để SET Nonce
 * @param {object} subClient - Redis Client dùng để SUBSCRIBE
 */
exports.subscribeAndVerifyEvents = (io, pubClient, subClient) => {
    subClient.subscribe(EVENT_CHAT_CHANNEL, async (rawMessage) => {
        let message;
        try {
            message = JSON.parse(rawMessage);
        } catch (e) {
            debugLog('ALERT: Failed to parse custom Redis message JSON:', rawMessage);
            return;
        }
        const { nonce, eventTime, signature, eventType, ...payload } = message;

        // 1. KIỂM TRA TIMESTAMP (CHỐNG REPLAY DÀI HẠN)
        const timeDifference = Math.abs(Date.now() / 1000 - eventTime);
        if (timeDifference > MAX_TIME_DIFF_SECONDS) {
            debugLog(`ALERT: Timestamp too old/new. Diff: ${timeDifference}s. Message rejected.`);
            return;
        }

        // 2. KIỂM TRA NONCE (CHỐNG REPLAY NGAY LẬP TỨC)
        if (await isNonceUsed(pubClient, nonce)) {
            debugLog(`ALERT: Replay attack detected. Nonce used: ${nonce}. Message rejected.`);
            return;
        }

        // 3. XÁC MINH CHỮ KÝ HMAC
        if (!verifyHMAC(message, signature, APP_SECRET_KEY)) {
            debugLog('SECURITY ALERT: Signature verification failed. Message rejected.');
            return;
        }

        // --- 4. XỬ LÝ VÀ PHÁT SỰ KIỆN HỢP LỆ ---
        // đang thiếu socketId emit từ php, đợi huongtd bắn lên
        debugLog(`Verified and processing event: ${eventType}, eventData: ${JSON.stringify(payload)}`);

        if (ALLOWED_EVENTS.includes(eventType)) {
            const { chatRoomId, senderId, socketId, ...rest } = payload;

            // Lấy tất cả socket từ mọi server thông qua Redis
            const sockets = await io.fetchSockets();

            for (const socket of sockets) {
                debugLog(`full detail id: ${socket.id}, 
                    auth: ${JSON.stringify(socket.data.userId)}, 
                    rooms: ${JSON.stringify(Array.from(socket.rooms))}
                `);
            }

            const targetSocketId = socketId || payload.socketId;
            if (chatRoomId) {
                const fullRoomId = `group:${chatRoomId}`;

                const finalPayload = {
                    ...rest,
                    senderId: payload.senderId || 'system',
                    chatRoomId: fullRoomId,
                    eventType: eventType
                };


                if (eventType === 'joinRoom') {

                    const switchRoomForSocket = (socket, newRoomId) => {
                        for (const room of socket.rooms) {
                            if (room.startsWith('group:') && room !== newRoomId) {
                                socket.leave(room);
                                debugLog(`[Auto-Switch] Socket ${socket.id} left ${room}`);
                            }
                        }
                        socket.join(newRoomId);
                        debugLog(`[Join] Socket ${socket.id} joined ${newRoomId}`);
                    };

                    if (targetSocketId) {
                        const targetSocket = io.sockets.sockets.get(targetSocketId);
                        if (targetSocket) {
                            switchRoomForSocket(targetSocket, fullRoomId);
                        } else {
                            debugLog(`[Warning] Socket ID ${targetSocketId} not found (User might have disconnected/refreshed).`);
                        }
                    }


                    else {
                        if (payload.sender && payload.sender.id) {
                            io.in(`user:${payload.sender.id}`).socketsJoin(fullRoomId);
                        }
                        if (payload.memberIds && Array.isArray(payload.memberIds)) {
                            payload.memberIds.forEach(uid => {
                                io.in(`user:${uid}`).socketsJoin(fullRoomId);
                            });
                        }
                    }
                }

                io.to(fullRoomId).emit(eventType, finalPayload);
                debugLog(`Broadcasted '${eventType}' to room '${fullRoomId}'`);


                if (payload.memberIds && Array.isArray(payload.memberIds)) {
                    let notifyEventName = 'roomUpdated';

                    if (eventType === 'deleteMsg') notifyEventName = 'deleteMsg';
                    if (eventType === 'pinMsg') notifyEventName = 'pinMsg';
                    if (eventType === 'editMsg') notifyEventName = 'editMsg';

                    payload.memberIds.forEach(targetUserId => {
                        io.to(`user:${targetUserId}`).emit(notifyEventName, finalPayload);
                    });

                    debugLog(`Notified outsiders via '${notifyEventName}' to ${payload.memberIds.length} users`);
                }

            } else {
                io.emit(eventType, payload);
            }
        }
    });
    debugLog(`Subscribed to custom Redis channel: ${EVENT_CHAT_CHANNEL} for event verification.`);
};
