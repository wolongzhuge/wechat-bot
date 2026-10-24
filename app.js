"use strict";

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const { WeChatClient } = require("./wechat/client");

// 查「连着发 cc 没反应，过一会儿才好」这类问题，全靠每条日志几点几分发生的
for (const fn of ["log", "error"]) {
    const orig = console[fn].bind(console);
    console[fn] = (...args) => orig("[" + new Date().toTimeString().slice(0, 8) + "]", ...args);
}

const config = {
    baseUrl: process.env.ipad_base_url || "http://127.0.0.1:8058/api",
    wxid: process.env.ipad_wxid,
    timeout: parseInt(process.env.ipad_timeout || "60000", 10),
    dumpRaw: (process.env.dump_raw || "false") === "true",
    rateLimit: {
        perMinute: parseInt(process.env.send_rate_per_minute || "40", 10),
        burst: parseInt(process.env.send_rate_burst || "4", 10),
        privateMs: parseInt(process.env.send_rate_private_ms || "1200", 10),
        groupMs: parseInt(process.env.send_rate_group_ms || "2200", 10),
    },
    seenFile: path.join(__dirname, "data", "seen.json"),
};

if (!config.wxid) {
    console.error("缺少 ipad_wxid。这套协议没有「列出已登录账号」的接口，机器人必须自己知道是谁：");
    console.error("  1) 先跑 D:\\wechat-ipad-kit\\run.sh 扫码登录；");
    console.error("  2) 登录成功后 redis 里那个 wxid_xxx 键就是它：");
    console.error("     wsl.exe -d ubuntu-docker -- docker exec wechat-redis redis-cli -n 2 --scan");
    console.error("  3) 写进 .env 的 ipad_wxid= 再来。");
    process.exit(1);
}

const client = new WeChatClient(config);

async function ensureOnline() {
    try {
        await client.ensureOnline();
    } catch (err) {
        console.error("连不上协议服务端 " + config.baseUrl + "：" + err.message);
        console.error("请先确认容器在跑：wsl.exe -d ubuntu-docker -- bash /mnt/d/wechat-ipad-kit/start-stack.sh");
        process.exit(1);
    }
    console.log("已登录，wxid = " + client.ourWxid);
    await client.enableAutoHeartBeat().catch((err) => console.error("开自动心跳失败: " + err.message));
}

exports.client = client;

// 无损更新三件套（都钉在 message/ command/ 之外，热重载不碰）：
// 1) 恢复状态快照（模式表 + 四张游戏桌）
// 2) 稳定的消息分发器（监听只挂一次，热重载换槽位）
// 3) 文件监听（改 message/ command/ 下的 .js 自动热重载）
require("./state/store").restore();
require("./dispatch");

// Load message handlers (same convention as the QQ version)
const messageHandlerDir = path.join(__dirname, "message");
fs.readdirSync(messageHandlerDir).forEach((file) => {
    require(path.resolve(messageHandlerDir, file));
});

process.on("unhandledRejection", (reason) => {
    console.log("Unhandled Rejection:", reason);
});

if (require.main === module) {
    ensureOnline()
        .then(() => {
            client.startPolling({
                interval: parseInt(process.env.poll_interval || "2000", 10),
                hotInterval: parseInt(process.env.hot_interval || "400", 10),
            });
            console.log("Service is now online! 轮询已启动 " + config.baseUrl +
                "（空闲 " + (process.env.poll_interval || 2000) + "ms / 有人说话 " + (process.env.hot_interval || 400) + "ms）");
            if ((process.env.hot_reload || "true") !== "false") {
                require("./hot/watch").startWatcher();
            }
            // 斗地主播报要写昵称，但命令本身是同步的，所以名字在后台灌进缓存；
            // 群成员四次接口就能灌完，先做这个；整个通讯录慢得多，排后面。
            client.preloadRoomNames().then(
                (n) => console.log("群成员昵称就绪：" + n + " 个"),
                (err) => console.error("预取群成员昵称失败: " + err.message),
            ).then(() => client.preloadNames((done, total) => {
                if (done % 100 === 0 || done >= total) console.log("通讯录昵称预取中：" + Math.min(done, total) + "/" + total);
            })).then(
                (n) => console.log("通讯录昵称就绪：" + n + " 个"),
                (err) => console.error("预取通讯录昵称失败: " + err.message),
            );
        })
        .catch((err) => {
            console.error(err.message);
            process.exit(1);
        });

    client.on("error", (err) => console.error(err.message));
}
