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
        console.log(ctx.session);

        /* ctx.session.awaiting = 'income_category';
        ctx.session.transactionType = 'income'; */

        // 2. Gửi tin nhắn
        await ctx.reply('✅ Bạn đã chọn Khoản thu. Vui lòng **nhập tên danh mục** bạn muốn thêm:');

        // 3. Xác nhận callback query (bắt buộc)
        await ctx.answerCbQuery();[3];
    });
    bot.action('select_outcome', (ctx) => ctx.reply('test'));

    /*  bot.on('text', async (ctx) => {
         // Lấy nội dung tin nhắn người dùng vừa nhập
         const userInput = ctx.message.text;
 
         // Kiểm tra trạng thái trong session
         if (ctx.session && ctx.session.awaiting === 'income_category') {
 
             // Đây chính là giá trị bạn cần log/lưu trữ
             const categoryName = userInput;
 
             // Log/lưu giá trị ra console (hoặc database)
             console.log(`Kiểu giao dịch: ${ctx.session.transactionType}, Tên danh mục vừa nhập: ${categoryName}`);
 
             // Gửi xác nhận lại cho người dùng
             await ctx.reply(`Đã lưu danh mục **${categoryName}** vào hệ thống.`);
 
             // Rất quan trọng: Xóa trạng thái chờ để bot không hiểu nhầm tin nhắn tiếp theo
             delete ctx.session.awaiting;
             delete ctx.session.transactionType;
 
         } else {
             // Xử lý các tin nhắn văn bản không nằm trong ngữ cảnh chờ (ví dụ: lời chào, spam)
             await ctx.reply('Xin lỗi, tôi không hiểu yêu cầu này. Vui lòng gõ /type để bắt đầu lại.');
         }
     }); */
};
