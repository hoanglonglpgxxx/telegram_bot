const { getLocalIP, debugLog } = require('./utils.js');
const { config, APP_SECRET_KEY } = require('./config.js');
const { registerHandlers } = require('./listeners.js');
const { initializeServer } = require('./connection.js');
const { subscribeAndVerifyEvents } = require('./eventHandler.js');

// Hàm main để khởi chạy server
async function startServer() {
    try {
        const ip = getLocalIP();
        const { app, server, io, pubClient, subClient } = await initializeServer();


        server.listen(config.port, "0.0.0.0", () => {
            debugLog(ip, `Server listening on https://${ip}:${config.port}`);
        });
        // Lắng nghe sự kiện từ PHP qua channel riêng
        subscribeAndVerifyEvents(io, pubClient, subClient);
        registerHandlers(io);

    } catch (err) {
        debugLog('NO_ADDR', 'Failed to start server:', err);
    }
}

startServer();