const { debugLog } = require('./utils.js');

function registerHandlers(ioInstance) {
    /**
     * Lấy danh sách userId của các socket hiện đang có trong một room.
     * @param {string} roomName - Tên room
     * @returns {userIds} - Mảng các userId
     */
    async function getCurrentUsersInRoom(roomName) {
        const sockets = await ioInstance.in(roomName).fetchSockets();
        const userIds = sockets.map(socket => socket.handshake.auth.userId || '');
        return userIds;
    }

    /**
    * Lấy danh sách user hiện tại đang có trong room và user của room nhưng đang không trong room
    * @param {string} chatRoomId - id của room
    * @param {string} memberIds - Mảng các user trong room lấy từ PHP
    * @returns {currentUsers} - Mảng các user đang trong room
    * @returns {notJoinedRoomUsers} - Mảng các user của room nhưng đang không trong room
    */
    async function getUsersList(chatRoomId, memberIds) {
        const currentUsers = await getCurrentUsersInRoom(chatRoomId);
        let notJoinedRoomUsers = memberIds.filter(e => {
            if (!currentUsers.includes(e)) return e;
        });
        return { currentUsers, notJoinedRoomUsers };
    }

    /* async function getJson(params = {}, timeout = 2000) {
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
    } */

    /**
     * Xử lý payload do client gửi lên rồi broadcast tới room tương ứng.
     * @param {Socket} socket - socket của client gửi event
     * @param {Server} ioInstance - instance Socket.IO server
     * @param {string} eventName - tên event
     * @param {object} data - payload gốc
     * @param {object} options - tuỳ chọn xử lý (ignoreSender, senderOnly, notifyOutsiders, beforeEmit...)
     */
    async function processAndBroadcast(socket, ioInstance, eventName, data, options = {}) {
        const userId = socket.handshake.auth.userId;
        const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

        if (!data.chatRoomId) {
            debugLog(clientIp, `Event '${eventName}' dropped: No roomId provided.`);
            return;
        }

        const fullRoomId = `group:${data.chatRoomId}`;
        /* let roomData = {};

        if (options.fetchRoomData) {
            try {
                roomData = await getJson({ id: data.chatRoomId });
            } catch (e) {
                debugLog(clientIp, `GET ROOM DATA FAILED | ${e.message}`);
            }
        } */

        let payload = {
            ...data,
            senderId: userId,
            chatRoomId: fullRoomId,
            createdTime: Date.now()
        };

        if (options.beforeEmit && typeof options.beforeEmit === 'function') {
            payload = await options.beforeEmit(payload, eventName);
        }

        /* if (Object.keys(roomData).length) {
            payload.roomData = roomData;
        } */

        if (!data.ignoreMultiTimes) {
            if (options.ignoreSender) {
                socket.to(fullRoomId).emit(eventName, payload);
            } else if (options.senderOnly) {
                socket.emit(eventName, payload);
            } else {
                ioInstance.to(fullRoomId).emit(eventName, payload);
            }
        } else {
            if (options.senderOnly) {
                socket.emit(eventName, payload);
            }
        }

        if (options.notifyOutsiders && data.memberIds) {
            const { notJoinedRoomUsers } = await getUsersList(fullRoomId, data.memberIds);
            debugLog(clientIp, `notJoinedRoomUsers users ${notJoinedRoomUsers}`);
            const outsiderEvent = options.outsiderEventName || 'roomUpdated';
            payload['eventType'] = 'private';
            notJoinedRoomUsers.forEach(user => {
                ioInstance.to(`user:${user}`).emit(outsiderEvent, payload);
                debugLog(clientIp, `Emitted ${outsiderEvent} to room user:${user}`);
            });
        }

        debugLog(clientIp, `Processed and broadcasted '${eventName}' from ${userId} to room '${fullRoomId}'`);
    }

    ioInstance.on('connection', (socket) => {
        const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
        debugLog(clientIp, `longlh| Client ${socket.id} connected`);

        const userId = socket.handshake.auth.userId;

        socket.join(`user:${userId}`);

        socket.on('joinRoom', async (data) => {
            const { chatRoomId, memberIds } = data;
            if (!chatRoomId || !Array.isArray(memberIds)) {
                debugLog(clientIp, `longlh JOINROOM | Missing params (roomId or memberIds is invalid)`);
                return;
            }

            const currentUsers = await getCurrentUsersInRoom(chatRoomId);
            if (memberIds.includes(userId) && !currentUsers.includes(userId)) {
                socket.join(chatRoomId);
                const joinedRooms = Array.from(socket.rooms).filter(room => room !== socket.id);
                if (joinedRooms.length) {
                    joinedRooms.forEach(curRoomName => {
                        if (curRoomName.includes('group') && curRoomName !== chatRoomId) socket.leave(curRoomName);
                    });
                }
                debugLog(clientIp, `longlh JOINROOM | User ${userId} joined ${chatRoomId}`);
            } else if (currentUsers.includes(userId)) {
                debugLog(clientIp, `longlh | User ${userId} is in room ${chatRoomId} already`);
            } else {
                debugLog(clientIp, `longlh | User ${userId} was blocked or not in by ${chatRoomId} with memberIds ${memberIds}`);
            }
        });

        const sendMsgOptions = {
            // fetchRoomData: false,
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
        // --- Logic cho client cũ ---
        socket.on('room', (room) => {
            socket.room = room;
            const rooms = room.split(',').filter(r => r.trim() !== '');
            if (rooms.length > 0) {
                socket.join(rooms);
                debugLog(clientIp, `${socket.id} joined room(s):`, room);
            }
        });
        const events = ['comments message', 'videochat', 'command'];
        for (const eventName of events) {
            socket.on(eventName, (data) => {
                debugLog(clientIp, `Received event '${eventName}' from ${socket.id}`);
                const targetRoom = data.room ? data.room : socket.room;
                if (targetRoom) {
                    socket.to(targetRoom).emit(eventName, data);
                    debugLog(clientIp, `Broadcasting event '${eventName}' to room '${targetRoom}' (excluding sender)`);
                } else {
                    ioInstance.emit(eventName, data);
                    debugLog(clientIp, `Broadcasting event '${eventName}' globally (NO ROOM)`);
                }
            });
        }

        socket.on('disconnect', () => {
            debugLog(clientIp, `Detect client disconnected: ${socket?.id}`);
        });
    });
}

module.exports = { registerHandlers };