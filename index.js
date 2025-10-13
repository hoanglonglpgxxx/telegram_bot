const dotenv = require('dotenv');
dotenv.config({ path: './.env' });

const { Telegraf, session } = require('telegraf');
const mongoose = require('mongoose');
const { Mongo } = require('@telegraf/session/mongodb');
const eventHandlers = require('./modules/eventHandlers');


if (!process.env.BOT_TOKEN) {
    console.error('Environment variable BOT_TOKEN is required. Add it to .env');
    process.exit(1);
}

const bot = new Telegraf(process.env.BOT_TOKEN);

const DB = process.env.DATABASE ? process.env.DATABASE.replace(
    '<PASSWORD>',
    encodeURIComponent(process.env.DATABASE_PASSWORD || '')
) : null;


async function main() {
    if (DB) {
        try {
            await mongoose.connect(DB, {
                serverSelectionTimeoutMS: 30000,
                socketTimeoutMS: 45000,
                retryWrites: true,
            });
            console.log('DB connected');
        } catch (err) {
            console.error('DB connection error:', err);
            process.exit(1);
        }
    } else {
        console.log('No DATABASE configuration found, skipping database connection');
    }

    const store = Mongo({
        client: mongoose.connection.getClient(),
        collection: 'chatbot_session'
    });

    bot.use(session({
        store,
        defaultSession: () => ({ counter: 0 })
    }));

    eventHandlers.handlers(bot);
    bot.start(async (ctx) => {
        ctx.session.counter = ctx.session.counter || 0;
        ctx.session.counter++;
        await ctx.reply(`Hello! You've started me ${ctx.session.counter} times.`);
    });
    // -----------------------------------------------------------
    // 6. KHỞI CHẠY BOT
    // -----------------------------------------------------------
    bot.launch()
        .then(() => console.log('Bot launched'))
        .catch((err) => console.error('Bot launch error:', err));

    // graceful shutdown
    process.once('SIGINT', () => bot.stop('SIGINT'));
    process.once('SIGTERM', () => bot.stop('SIGTERM'));
}

main().catch(err => console.error('Bot startup failed:', err));
