// eventHandler.js
const crypto = require('crypto');
const { APP_SECRET_KEY } = require('./config');
const { debugLog } = require('./utils.js');
const EVENT_CHAT_CHANNEL = 'vsystem_chat_event';
const NONCE_TTL_SECONDS = 60;
const MAX_TIME_DIFF_SECONDS = 60;
const ALLOWED_EVENTS = ['newMsg', 'userTyping', 'userStopTyping', 'deleteMsg', 'pinMsg', 'editMsg', 'reactMsg', 'addTag', 'roomUpdated', 'notifyConfig', 'editRoom', 'pinRoom', 'joinRoom', 'deleteRoom'];
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
    if (dataToVerify.signature) {
        delete dataToVerify.signature;
    }
    const sortedData = sortObject(dataToVerify);
    let canonicalString = JSON.stringify(sortedData);
    canonicalString = canonicalString.replace(/\//g, '\\/');
    const expectedSignature = crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
    try {
        return crypto.timingSafeEqual(Buffer.from(receivedSignature, 'hex'), Buffer.from(expectedSignature, 'hex'));
    } catch (e) {
        debugLog("TimingSafeEqual failed:", e.message);
        return false;
    }
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

            // for (const socket of sockets) {
            //     debugLog(`full detail id: ${socket.id}, 
            //         auth: ${JSON.stringify(socket.data.userId)}, 
            //         rooms: ${JSON.stringify(Array.from(socket.rooms))}
            //     `);
            // }

            const targetSocketId = socketId || payload.socketId;
            if (!targetSocketId) {
                debugLog('Missing params: socketId');
            }
            if (chatRoomId) {
                const fullRoomId = `group:${chatRoomId}`;

                const finalPayload = {
                    ...rest,
                    senderId: payload.senderId || 'system',
                    chatRoomId: fullRoomId,
                    eventType: eventType,
                    socketId: targetSocketId
                };


                if (eventType === 'joinRoom') {

                    // Hàm Helper: Rời phòng cũ -> Vào phòng mới
                    const switchRoomForSocket = (socket, newRoomId) => {
                        for (const room of socket.rooms) {
                            if (room.startsWith('group:') && room !== newRoomId) {
                                socket.leave(room);
                                debugLog(`[Auto-Switch] Socket ${socket.id} left ${room}`);
                            }
                        }
                        // Kiểm tra nếu chưa join thì mới join (đỡ log trùng)
                        if (!socket.rooms.has(newRoomId)) {
                            socket.join(newRoomId);
                            debugLog(`[Join] Socket ${socket.id} joined ${newRoomId}`);
                        }
                        if (!socket.rooms) {
                            debugLog(`[ERROR] Socket ${socket.id} cant join ${newRoomId}`);
                        }
                    };

                    if (targetSocketId) {
                        try {
                            const socketsOfTarget = await io.in(targetSocketId).fetchSockets();
                            debugLog(`current sockets ${socketsOfTarget}`);
                            if (socketsOfTarget.length > 0) {
                                const targetSocket = socketsOfTarget[0];

                                debugLog(`[Cluster] Found socket ${targetSocketId} on node ${targetSocket.id === targetSocketId ? 'LOCAL' : 'REMOTE'}. Switching...`);

                                // 1. Auto-Switch: Rời phòng group cũ
                                // targetSocket.rooms là Set, duyệt qua nó
                                for (const room of targetSocket.rooms) {
                                    if (room.startsWith('group:') && room !== fullRoomId) {
                                        targetSocket.leave(room); // Lệnh này sẽ được bắn qua Redis
                                        debugLog(`[Auto-Switch] Socket ${targetSocketId} left ${room}`);
                                    }
                                }

                                // 2. Join phòng mới
                                targetSocket.join(fullRoomId);
                                debugLog(`[Join] Socket ${targetSocketId} joined ${fullRoomId}`);

                            } else {
                                // Socket không tồn tại trên bất kỳ server nào (đã disconnect)
                                debugLog(`[Info] Socket ${targetSocketId} not found in cluster.`);
                            }
                        } catch (e) {
                            debugLog(`[Error] Cluster socket fetch failed: ${e.message}`);
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
                    if (eventType === 'deleteRoom') notifyEventName = 'deleteRoom';

                    payload.memberIds.forEach(targetUserId => {
                        io.to(`user:${targetUserId}`).emit(notifyEventName, finalPayload);
                    });

                    debugLog(`Notified outsiders via '${notifyEventName}' to ${payload.memberIds.length} users`);
                }

            }
        } else {
            io.emit(eventType, payload);
        }
    });
    debugLog(`Subscribed to custom Redis channel: ${EVENT_CHAT_CHANNEL} for event verification.`);
};
