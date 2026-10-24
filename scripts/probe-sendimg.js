"use strict";
// 验证 /Msg/SendImg 到底收不收 base64 PNG——五子棋的盘面要不要走图片，全看这条
const path = require("path");
const fs = require("fs");
require("dotenv").config({ path: path.join(__dirname, "..", ".env") });
const { WeChatClient } = require("../wechat/client");
const { Canvas } = require("../utils/png");

const client = new WeChatClient({
    baseUrl: process.env.ipad_base_url || "http://127.0.0.1:8058/api",
    wxid: process.env.ipad_wxid,
    timeout: 60000,
});

(async () => {
    await client.ensureOnline();

    const cv = new Canvas(240, 240, [220, 180, 110]);
    cv.rect(10, 10, 229, 229, [90, 60, 20]);
    for (let i = 0; i < 5; i++) {
        const p = 30 + i * 45;
        cv.lineH(p, 20, 220, [70, 45, 15]);
        cv.lineV(p, 20, 220, [70, 45, 15]);
    }
    cv.circle(75, 75, 18, [20, 20, 20]);
    cv.circle(120, 120, 18, [250, 250, 250]);
    cv.circle(165, 75, 18, [200, 30, 30]);
    cv.text("R1C1", 20, 200, [250, 250, 250], 2);

    const png = cv.toBuffer();
    const out = path.join(__dirname, "..", "data", "board-sample.png");
    fs.writeFileSync(out, png);
    console.log("PNG 生成：", png.length, "字节 →", out);
    // PNG 头 + IHDR 宽度，验证编码器写对了没
    console.log("签名 ok:", png.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])));
    console.log("IHDR 宽×高:", png.readUInt32BE(16), "×", png.readUInt32BE(20));

    const b64 = png.toString("base64");
    try {
        const r = await client.sendImage("filehelper", b64);
        console.log("UploadImg 成功 Code=" + r.Code + " " + r.Message);
    } catch (err) {
        console.log("UploadImg 失败: " + err.message.slice(0, 200));
    }
    process.exit(0);
})().catch((e) => { console.error("崩了: " + e.message); process.exit(1); });
