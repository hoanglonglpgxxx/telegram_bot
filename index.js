const { Telegraf, session } = require('telegraf');
import { type Context } from 'telegraf';
import type { Update } from "telegraf/types";
const dotenv = require('dotenv');
const mongoose = require('mongoose');
const eventHandlers = require('./modules/eventHandlers');

interface MyContext<U extends Update = Update> extends Context<U> {
    session: {
        count: number;
    },
};


dotenv.config({ path: './.env' });
const bot = new Telegraf < MyContext > (process.env.BOT_TOKEN);
const DB = process.env.DATABASE.replace(
    '<PASSWORD>', encodeURIComponent(process.env.DATABASE_PASSWORD)
);
mongoose
    .connect(
        DB
    ).then(() => console.log('DB connected'));

eventHandlers.handlers(bot);
bot.use(session({ defaultSession: () => ({ count: 0 }) }));
bot.launch();