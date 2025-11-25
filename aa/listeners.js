const { debugLog } = require('./utils.js');

function registerHandlers(ioInstance) {
    /**
     * Lấy danh sách userId của các socket hiện đang có trong một room.
     * @param {string} roomName - Tên room
     * @returns {userIds} - Mảng các userId
     */
    async function getCurrentUsersInRoom(roomName) {
        try {
            const sockets = await Promise.race([
                ioInstance.in(roomName).fetchSockets(),
                new Promise((_, reject) =>
                    setTimeout(() => reject(new Error('Redis fetch timeout')), 5000)
                )
            ]);

            const userIds = sockets.map(socket => {
                return (socket.handshake && socket.handshake.auth && socket.handshake.auth.userId)
                    ? socket.handshake.auth.userId
                    : '';
            });
            return userIds;

        } catch (e) {
            debugLog('NO_ADDR', `Skipping room check for ${roomName}: ${e.message}`);
            return [];
        }
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
        let notJoinedRoomUsers = memberIds.filter(e => !currentUsers.includes(e));
        return { currentUsers, notJoinedRoomUsers };
    }


    /**
     * Xử lý payload do client gửi lên rồi broadcast tới room tương ứng.
     * @param {Socket} socket - socket của client gửi event
     * @param {Server} ioInstance - instance Socket.IO server
     * @param {string} eventName - tên event
     * @param {object} data - payload gốc
     * @param {object} options - tuỳ chọn xử lý (ignoreSender, senderOnly, notifyOutsiders, beforeEmit...)
     */
    async function processAndBroadcast(socket, ioInstance, eventName, data, options = {}) {
        try {
            debugLog('processing...');
            const userId = socket.handshake.auth.userId;
            const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

            if (!data.chatRoomId) {
                debugLog(clientIp, `Event '${eventName}' dropped: No roomId provided.`);
                return;
            }

            const fullRoomId = `group:${data.chatRoomId}`;

            let payload = {
                ...data,
                senderId: userId,
                chatRoomId: fullRoomId,
                createdTime: Date.now()
            };

            if (options.beforeEmit && typeof options.beforeEmit === 'function') {
                payload = await options.beforeEmit(payload, eventName);
            }

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
                try {
                    const { notJoinedRoomUsers } = await getUsersList(fullRoomId, data.memberIds);
                    const outsiderEvent = options.outsiderEventName || 'roomUpdated';
                    payload['eventType'] = 'private';

                    notJoinedRoomUsers.forEach(user => {
                        ioInstance.to(`user:${user}`).emit(outsiderEvent, payload);
                    });
                } catch (err) {
                    debugLog(clientIp, `Failed to notify outsiders: ${err.message}`);
                }
            }

            debugLog(clientIp, `Processed '${eventName}' from ${userId} to '${fullRoomId}' `);
        } catch (err) {
            debugLog('NO_ADDR', `CRITICAL ERROR in processAndBroadcast: ${err.message}`);
        }
    }

    ioInstance.on('connection', (socket) => {
        const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;

        const userId = socket.handshake.auth.userId;
        debugLog(clientIp, ` Client ${socket.id} connected and user room is user:${userId}`);

        socket.join(`user:${userId}`);
        if (userId && userId !== 'undefined') {
            // --- QUAN TRỌNG: LƯU VÀO DATA ĐỂ FETCH ĐƯỢC ---
            socket.data.userId = userId;
            // ----------------------------------------------
        }

        socket.on('joinRoom', async (data) => {
            try {
                const { chatRoomId, memberIds } = data;
                if (!chatRoomId || !Array.isArray(memberIds)) {
                    debugLog(clientIp, `longlh JOINROOM | Missing params`);
                    return;
                }

                if (memberIds.includes(userId)) {
                    socket.join(chatRoomId);
                    const joinedRooms = Array.from(socket.rooms).filter(room => room !== socket.id);
                    if (joinedRooms.length) {
                        joinedRooms.forEach(curRoomName => {
                            if (curRoomName.includes('group') && curRoomName !== chatRoomId) socket.leave(curRoomName);
                        });
                    }
                    debugLog(clientIp, `longlh JOINROOM | User ${userId} joined ${chatRoomId}`);
                } else {
                    const currentUsers = await getCurrentUsersInRoom(chatRoomId);
                    if (currentUsers.includes(userId)) {
                        debugLog(clientIp, `longlh | User ${userId} is in room ${chatRoomId} already`);
                    } else {
                        debugLog(clientIp, `longlh | User ${userId} Access Denied to ${chatRoomId}`);
                    }
                }
            } catch (err) {
                debugLog(clientIp, `longlh JOINROOM ERROR | ${err.message}`);
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
        // --- Logic cho client cũ - Longlh remove log ---
        socket.on('room', (room) => {
            socket.room = room;
            const rooms = room.split(',').filter(r => r.trim() !== '');
            if (rooms.length > 0) {
                socket.join(rooms);
                //debugLog(clientIp, `${socket.id} joined room(s):`, room);
            }
        });
        const events = ['comments message', 'videochat', 'command'];
        for (const eventName of events) {
            socket.on(eventName, (data) => {
                debugLog(clientIp, `Received event '${eventName}' from ${socket.id}`);
                const targetRoom = data.room ? data.room : socket.room;
                if (targetRoom) {
                    socket.to(targetRoom).emit(eventName, data);
                    //debugLog(clientIp, `Broadcasting event '${eventName}' to room '${targetRoom}' (excluding sender)`);
                } else {
                    ioInstance.emit(eventName, data);
                    //debugLog(clientIp, `Broadcasting event '${eventName}' globally (NO ROOM)`);
                }
            });
        }

        socket.on('disconnect', () => {
            debugLog(clientIp, `Detect client disconnected: ${socket?.id}`);
        });
    });
}

module.exports = { registerHandlers };