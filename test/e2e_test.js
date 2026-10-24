"use strict";

// node test/e2e_test.js
// 真的把 app.js 作为子进程拉起来，验证「拉消息 -> 解析 -> 分发到 message/*.js -> 回消息」整条链路。
// 用假的 iwechat 服务端，不需要 token，也不需要 OpenAI Key。

const http = require("http");
const { spawn } = require("child_process");
const path = require("path");

const ME = "wxid_e2e_bot";
const PORT = 18850;
const received = [];
let queue = [];

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        const url = req.url.split("?")[0];
        const json = (obj) => {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify(obj));
        };
        if (url === "/login/GetLoginStatus") return json({ success: true, data: { wxid: ME, online: true } });
        if (url === "/message/HttpSyncMsg") {
            const list = queue.splice(0);
            return json({ success: true, data: { list: list } });
        }
        if (url === "/message/SendTextMessage") {
            (JSON.parse(body || "{}").MsgItem || []).forEach((i) => received.push(i));
            return json({ success: true, data: { BaseResponse: { ErrCode: 0 } } });
        }
        json({ success: false, message: "not mocked: " + url });
    });
});

server.listen(PORT, () => {
    const child = spawn(process.execPath, [path.join(__dirname, "..", "app.js")], {
        cwd: path.join(__dirname, ".."),
        env: Object.assign({}, process.env, {
            iwechat_base_url: "http://127.0.0.1:" + PORT,
            iwechat_key: "e2e",
            private: "true",
            group: "true",
            dump_raw: "false",
            poll_interval: "500",
        }),
        stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));

    // 登录后 1.5s 投一条私聊消息进队列，等机器人回
    setTimeout(() => {
        queue = [{ FromUser: "wxid_friend", ToUserName: ME, MsgType: 1, Content: "端到端测试", CreateTime: Date.now(), NewMsgId: "e2e-1" }];
    }, 1500);

    setTimeout(() => {
        child.kill();
        server.close();
        const ok = out.includes("Service is now online");
        console.log("--- app.js 输出 ---\n" + out.trim());
        console.log("--- 机器人发出的消息 ---\n" + JSON.stringify(received, null, 2));
        if (!ok) return console.error("\n[失败] 没有进入 online 状态");
        if (received.length === 0) return console.error("\n[失败] 一条回复都没发出去");
        if (received[0].ToUserName !== "wxid_friend") return console.error("\n[失败] 回复目标不对");
        console.log("\n[通过] app.js 启动 -> 轮询 -> 解析私聊 -> 走 openai_api -> 发回 wxid_friend");
    }, 8000);
});
