const fs = require('fs');
const { debugLog } = require('./utils.js');

// --- Config ---
const config = {
    redisHost: process.env.REDIS_HOST || "",
    redisPort: process.env.REDIS_PORT || 0,
    redisPassword: process.env.REDIS_PASSWORD || "",
    sslKey: process.env.SSL_KEY_PATH || "",
    sslCert: process.env.SSL_CERT_PATH || "",
    secretKey: process.env.SECRET_KEY_PATH || "",
    port: process.env.PORT || 0
};

// --- Validate Config ---
if (!config.redisHost || config.redisPort === 0 || !config.redisPassword) {
    debugLog("ERROR: Missing required Redis configuration. Exiting.");
    process.exit(1);
} else {
    debugLog(`Redis config: ${JSON.stringify(config)}`);
}

// --- Load Secret Key ---
let APP_SECRET_KEY = '';
try {
    APP_SECRET_KEY = fs.readFileSync(config.secretKey, 'utf8').trim();
    debugLog('NO_ADDR', 'Successfully loaded secret key.');
} catch (err) {
    debugLog('NO_ADDR', 'FATAL ERROR: Could not read secretKey.', err.message);
}

module.exports = {
    config,
    APP_SECRET_KEY
};