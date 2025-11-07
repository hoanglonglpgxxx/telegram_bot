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

/**
 * Hàm xác minh chữ ký HMAC-SHA256.
 * @param {object} payload - Toàn bộ tin nhắn nhận được.
 * @param {string} receivedSignature - Chữ ký đính kèm.
 * @param {string} secret - Khóa bí mật chia sẻ.
 * @returns {boolean} Kết quả xác minh.
 */
function verifyHMAC(payload, receivedSignature, secret) {
    const dataToVerify = { ...payload };
    delete dataToVerify.signature;
    const canonicalString = canonicalizePayload(dataToVerify);
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
        debugLog(`Verified and processing event: ${eventType}, eventData: ${JSON.stringify(payload)}`);
        if (ALLOWED_EVENTS.includes(eventType)) {

            const { chatRoomId, senderId, ...rest } = payload;

            if (chatRoomId) {
                const fullRoomId = `group:${chatRoomId}`;
                const finalPayload = {
                    ...rest,
                    senderId: payload.senderId || 'system',
                    roomId: fullRoomId,
                    createdTime: Date.now(),

                    chatRoomId: chatRoomId
                };
                io.to(fullRoomId).emit(eventType, finalPayload);

                debugLog(`Broadcasted event '${eventType}' from Redis to room '${fullRoomId}'`);

            } else {
                debugLog(`ALERT: Event '${eventType}' from Redis has no chatRoomId. Emitting globally.`);
                io.emit(eventType, payload);
            }
        }
    });
    debugLog(`Subscribed to custom Redis channel: ${EVENT_CHAT_CHANNEL} for event verification.`);
};
