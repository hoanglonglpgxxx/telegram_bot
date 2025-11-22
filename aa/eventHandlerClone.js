// eventHandler.js
const crypto = require('crypto');
const { APP_SECRET_KEY } = require('./config');
const { debugLog } = require('./utils.js');
const EVENT_CHAT_CHANNEL = 'vsystem_chat_event';
const NONCE_TTL_SECONDS = 60;
const MAX_TIME_DIFF_SECONDS = 60;
const ALLOWED_EVENTS = ['newMsg', 'userTyping', 'userStopTyping', 'deleteMsg', 'pinMsg', 'editMsg', 'reactMsg', 'addTag', 'roomUpdated', 'notifyConfig', 'editRoom', 'pinRoom'];
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
        debugLog(`Verified and processing event: ${eventType}, eventData: ${JSON.stringify(payload)}`);
        if (ALLOWED_EVENTS.includes(eventType)) {
            const { chatRoomId, senderId, ...rest } = payload;

            if (chatRoomId) {
                const fullRoomId = `group:${chatRoomId}`;

                const finalPayload = {
                    ...rest,
                    senderId: payload.senderId || 'system',
                    chatRoomId: fullRoomId,
                    createdTime: Date.now(),
                    eventType: eventType
                };

                // ---------------------------------------------------------
                // 1. PHÁT SỰ KIỆN CHÍNH (Vào Room Chat)
                // ---------------------------------------------------------
                // Ví dụ: eventType là 'newMsg' -> Ai trong room sẽ nhận được 'newMsg'
                io.to(fullRoomId).emit(eventType, finalPayload);
                debugLog(`Broadcasted '${eventType}' to room '${fullRoomId}'`);


                // ---------------------------------------------------------
                // 2. PHÁT SỰ KIỆN THÔNG BÁO (Logic thay thế roomUpdated cũ)
                // ---------------------------------------------------------
                // Chỉ xử lý khi payload có danh sách thành viên (PHP phải gửi kèm memberIds)
                if (payload.memberIds && Array.isArray(payload.memberIds)) {

                    // Xác định tên sự kiện thông báo. 
                    // Nếu là 'newMsg' thì thông báo là 'roomUpdated'.
                    // Nếu là 'deleteMsg' thì thông báo là 'deleteMsg' (tuỳ logic cũ của bạn)
                    let notifyEventName = 'roomUpdated';

                    // Tùy chỉnh tên event phụ dựa trên event chính (giống logic cũ listeners.js)
                    if (eventType === 'deleteMsg') notifyEventName = 'deleteMsg';
                    if (eventType === 'pinMsg') notifyEventName = 'pinMsg';
                    if (eventType === 'editMsg') notifyEventName = 'editMsg';

                    // Gửi đến kênh riêng của từNG thành viên
                    payload.memberIds.forEach(targetUserId => {
                        // Gửi vào kênh user:ID
                        // Client sẽ nhận được event 'roomUpdated' tại đây
                        io.to(`user:${targetUserId}`).emit(notifyEventName, finalPayload);
                    });

                    debugLog(`Notified outsiders via '${notifyEventName}' to ${payload.memberIds.length} users`);
                }

                // ---------------------------------------------------------
                // 3. XỬ LÝ JOIN NGẦM (Như đã bàn ở câu trước)
                // ---------------------------------------------------------
                if (eventType === 'joinRoom' && payload.sender && payload.sender.id) {
                    io.in(`user:${payload.sender.id}`).socketsJoin(fullRoomId);
                }

            } else {
                io.emit(eventType, payload);
            }
        }
    });
    debugLog(`Subscribed to custom Redis channel: ${EVENT_CHAT_CHANNEL} for event verification.`);
};
