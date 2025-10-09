dotenv.config({ path: './.env' });
eventHandlers.handlers(bot);
const { Telegraf, session } = require('telegraf');
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const eventHandlers = require('./modules/eventHandlers');

dotenv.config({ path: './.env' });

if (!process.env.BOT_TOKEN) {
    console.error('Environment variable BOT_TOKEN is required. Add it to .env');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const DB = process.env.DATABASE ? process.env.DATABASE.replace(
    '<PASSWORD>',
    encodeURIComponent(process.env.DATABASE_PASSWORD || '')
) : null;

if (DB) {
    mongoose
        .connect(DB)
        .then(() => console.log('DB connected'))
        .catch((err) => console.error('DB connection error:', err));
} else {
    console.log('No DATABASE configuration found, skipping database connection');
}

// register session middleware before handlers so handlers can use ctx.session
bot.use(session({ defaultSession: () => ({ count: 0 }) }));

// attach handlers
eventHandlers.handlers(bot);

bot.launch()
    .then(() => console.log('Bot launched'))
    .catch((err) => console.error('Bot launch error:', err));

// graceful shutdown
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));