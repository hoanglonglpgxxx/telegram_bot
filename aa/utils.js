const os = require('os');

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

module.exports = {
    getLocalIP,
    formatDateTime,
    debugLog
};