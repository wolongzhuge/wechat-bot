"use strict";

// 单独登录用：node scripts/login.js
// 二维码保存后用微信扫码，脚本会自动轮询直到登录成功。
const path = require("path");
require("dotenv").config();
const { WeChatClient } = require("../wechat/client");

const client = new WeChatClient({
    baseUrl: process.env.iwechat_base_url || "http://127.0.0.1:8849",
    key: process.env.iwechat_key,
    dumpRaw: true,
});

(async () => {
    let status;
    try {
        status = await client.getLoginStatus();
    } catch (err) {
        console.error("连不上 iwechat 服务端：" + err.message);
        console.error("先确认 D:\\iwechat\\myapp.exe 已经带 token 启动，并且 MySQL/Redis 在跑（start-deps.bat）。");
        process.exit(1);
    }
    if (client.isLoggedIn(status)) {
        console.log("当前已登录，wxid = " + client.ourWxid);
        return;
    }

    const qrFile = path.join(__dirname, "..", "data", "qrcode.png");
    await client.saveLoginQrCode(qrFile);
    console.log("二维码已保存：" + qrFile);
    console.log("打开它，用「要做机器人的那个微信号」扫码，然后在手机上点确认。");

    for (let i = 0; i < 150; i++) {
        await new Promise((r) => setTimeout(r, 2000));
        const st = await client.checkLoginStatus().catch((e) => ({ error: e.message }));
        if (client.isLoggedIn(st)) {
            console.log("登录成功！wxid = " + client.ourWxid);
            console.log("把这个 wxid 加进 D:\\iwechat\\assets\\owner.json 可以拿到管理接口权限。");
            return;
        }
        if (i % 15 === 14) console.log("  仍在等待扫码…… " + JSON.stringify(st).slice(0, 160));
    }
    console.error("5 分钟内没有完成扫码，退出。");
    process.exit(1);
})();
