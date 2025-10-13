const Category = require('../models/categoryModel');

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
    bot.action('select_income', async (ctx) => {

        ctx.session.awaiting = 'income_category';
        ctx.session.transactionType = 'income';
        console.log(ctx.session);

        // 2. Gửi tin nhắn
        await ctx.reply('✅ Bạn đã chọn Khoản thu. Vui lòng **nhập tên danh mục** bạn muốn thêm:');

        // 3. Xác nhận callback query (bắt buộc)
        await ctx.answerCbQuery();
    });
    bot.action('select_outcome', (ctx) => ctx.reply('test'));

    bot.on('text', async (ctx) => {
        // Lấy nội dung tin nhắn người dùng vừa nhập
        const userInput = ctx.message.text;

        // Kiểm tra trạng thái trong session
        if (ctx.session && ctx.session.awaiting === 'income_category') {

            // Đây chính là giá trị bạn cần log/lưu trữ
            const categoryName = userInput;

            // Log/lưu giá trị ra console (hoặc database)
            console.log(`Kiểu giao dịch: ${ctx.session.transactionType}, Tên danh mục vừa nhập: ${categoryName}`);

            try {
                const category = await Category.create({ name: categoryName });
                await ctx.reply(`Đã lưu danh mục **${category.name}** vào hệ thống.`);
            } catch (err) {
                if (err.code === 11000) {
                    await ctx.reply('Danh mục này đã tồn tại. Nhập khoản chi tiêu');
                    ctx.session.awaiting = 'spendValue';
                    ctx.session.currentCategory = `${categoryName}`;
                } else if (err.name === 'ValidationError') {
                    const messages = Object.values(err.errors).map(e => e.message).join('; ');
                    await ctx.reply(`Lỗi dữ liệu: ${messages}`);
                } else {
                    console.error('Error saving category:', err);
                    await ctx.reply('Đã xảy ra lỗi khi lưu danh mục. Vui lòng thử lại sau.');
                }
            }

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
        const spendValue = msg;

        try {
            // const category = await Category.create({ name: categoryName });
            const money = spendValue;
            await ctx.reply(`Đã nhập **${money}** ₫ vào bảng **${ctx.session.currentCategory}**.`);
        } catch (err) {
            if (err.name === 'ValidationError') {
                const messages = Object.values(err.errors).map(e => e.message).join('; ');
                await ctx.reply(`Lỗi dữ liệu: ${messages}`);
            } else {
                console.error('Error saving category:', err);
                await ctx.reply('Đã xảy ra lỗi khi lưu danh mục. Vui lòng thử lại sau.');
            }
        }
        delete ctx.session.currentCategory;
        delete ctx.session.awaiting;
    }
};
