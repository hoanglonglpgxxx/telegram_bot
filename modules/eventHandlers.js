const fs = require('fs');
const Category = require('../models/categoryModel');

function writeLog(message) {
    const timestamp = new Date().toISOString();
    const logEntry = `${timestamp} - ${message}\n`;

    fs.appendFile('./logs/application.log', logEntry, (err) => {
        if (err) {
            console.error('Failed to write to log file:', err);
        }
    });
}


exports.handlers = function (bot) {
    bot.start((ctx) => ctx.reply('Welcome!'));
    bot.help((ctx) => ctx.reply('Help'));
    bot.command('type', (ctx) => {
        ctx.reply('Chọn kiểu giao dịch bạn muốn nhập:', {
            reply_markup: {
                inline_keyboard: [
                    [
                        { text: 'Khoản thu (Income)', callback_data: 'select_income' },
                        { text: 'Khoản chi (Outcome)', callback_data: 'select_outcome' }
                    ]
                ]
            }
        });
    });
    bot.command('clear', async (ctx) => {
        ctx.session = {};
        await ctx.reply('Xóa session thành công !');
        writeLog(`${Date.now()} | Xóa session thành công!`);
    });
    bot.action('select_income', async (ctx) => {
        console.log(ctx);
        ctx.session.awaiting = 'income_category';
        ctx.session.transactionType = 'income';
        console.log(ctx.session);

        // 2. Gửi tin nhắn
        await ctx.reply('✅ Bạn đã chọn Khoản thu. Vui lòng <b>nhập tên danh mục</b> bạn muốn thêm:', { parse_mode: 'HTML' });
        writeLog(`${Date.now()} | select_income`);
        // 3. Xác nhận callback query (bắt buộc)
        await ctx.answerCbQuery();
    });
    bot.action('select_outcome', (ctx) => ctx.reply('test'));

    bot.on('text', async (ctx) => {
        // Lấy nội dung tin nhắn người dùng vừa nhập
        const userInput = ctx.message.text;

        // Kiểm tra trạng thái trong session
        if (ctx.session && ctx.session.awaiting === 'income_category') {
            const categoryName = userInput;

            console.log(`Kiểu giao dịch: ${ctx.session.transactionType}, Tên danh mục vừa nhập: ${categoryName}`);

            try {
                const category = await Category.create({ name: categoryName });
                await ctx.reply(`Đã lưu danh mục <b>${category.name}</b> vào DB. Nhập khoản chi tiêu: `, { parse_mode: 'HTML' });
                writeLog(`${Date.now()} | Đã lưu danh mục ${category.name} vào DB`);
            } catch (err) {
                if (err.code === 11000) {
                    await ctx.reply('Danh mục này đã tồn tại. Nhập khoản chi tiêu: ');
                } else if (err.name === 'ValidationError') {
                    const messages = Object.values(err.errors).map(e => e.message).join('; ');
                    await ctx.reply(`Lỗi dữ liệu: ${messages}`);
                } else {
                    console.error('Error saving category:', err);
                    await ctx.reply('Đã xảy ra lỗi khi lưu danh mục. Vui lòng thử lại sau.');
                }
            }
            ctx.session.awaiting = 'spendValue';
            ctx.session.currentCategory = `${categoryName}`;
            delete ctx.session.transactionType;

        } else if (ctx.session && ctx.session.awaiting === 'spendValue') {
            handleAddMoney(userInput, ctx);
        }
        else {
            // Xử lý các tin nhắn văn bản không nằm trong ngữ cảnh chờ (ví dụ: lời chào, spam)
            await ctx.reply('Xin lỗi, tôi không hiểu yêu cầu này. Vui lòng gõ /type để bắt đầu lại.');
        }
    });

    async function handleAddMoney(msg, ctx) {
        let moneyMsg = msg;
        console.log(ctx.session);

        moneyMsg = moneyMsg.trim().split('|');
        try {
            // const category = await Category.create({ name: categoryName });
            const money = parseFloat(moneyMsg[0].trim());
            if (money) {
                await ctx.reply(`Đã nhập <b>${money}</b>₫, mục đích: <b>${moneyMsg[1].trim()}</b>, vào bảng <b>${ctx.session.currentCategory}</b>.`, { parse_mode: 'HTML' });
                writeLog(`${Date.now()} | Đã nhập ${money}₫, mục đích: ${moneyMsg[1].trim()}, vào bảng${ctx.session.currentCategory}.`);
                delete ctx.session.currentCategory;
                delete ctx.session.awaiting;
            } else {
                await ctx.reply(`Số tiền sai định dạng, nhập lại`);
            }
        } catch (err) {
            if (err.name === 'ValidationError') {
                const messages = Object.values(err.errors).map(e => e.message).join('; ');
                await ctx.reply(`Lỗi dữ liệu: ${messages}`);
            } else {
                console.error('Error saving category:', err);
                await ctx.reply('Đã xảy ra lỗi khi lưu số tiền.');
            }
            delete ctx.session.currentCategory;
            delete ctx.session.awaiting;
        }

    }

    bot.command('delete', (ctx) => {
        console.log(123);
        let k = 0;
        for (let i = 0; i <= 100; i++) {
            k = ctx.message.message_id - i;
            ctx.deleteMessage(k);
        }
    });
};
