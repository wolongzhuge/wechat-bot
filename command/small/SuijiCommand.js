function suijiCommand(event) {
    // 原 QQ 版接的是外部图接口，移植时没接图源；这里只给提示，别再抛 I is not defined
    event.reply("随机图片还没接图源。可以试：cc肯德基 / cc搜歌 关键词 / cc天气 北京");
}

module.exports = { suijiCommand };
