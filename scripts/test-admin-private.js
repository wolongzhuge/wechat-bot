"use strict";

// node scripts/test-admin-private.js
// 管理员模式「只在私聊生效」的路由测试：stub 掉 app.js 和 qoder cli，不碰真实登录态、不连网络。
// 覆盖：暗号进入 / 非管理员沉默 / 不带 cc 只聊天 / cc 开头跑电脑操作 / cc退出 / 群里不再接终端。

const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const ROOT = path.join(__dirname, "..");
const TMP_ADMIN = path.join(__dirname, "tmp-admin-private.json");
const TMP_STATE = path.join(__dirname, "tmp-admin-private-state.json");
process.env.admin_state_file = TMP_ADMIN;
process.env.state_file = TMP_STATE;
process.env.private = "true";
for (const f of [TMP_ADMIN, TMP_ADMIN + ".tmp", TMP_STATE, TMP_STATE + ".tmp"]) {
    try { fs.unlinkSync(f); } catch (err) { /* 不存在就跳过 */ }
}

let failures = 0;
function check(name, cond, detail) {
    if (cond) console.log("PASS " + name);
    else {
        failures++;
        console.error("FAIL " + name + (detail === undefined ? "" : "  ← " + detail));
    }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    // ---- 1. 打桩 qoder cli：只拦 cli 调用，其余命令（2233/cc 的 run 工具）照常真跑 ----
    const cp = require("child_process");
    const realSpawn = cp.spawn;
    let qoderReplies = [];
    cp.spawn = (bin, args, opts) => {
        const expectBin = process.env.qoder_cli_bin || "qoderclicn";
        if (bin !== expectBin) return realSpawn(bin, args, opts);
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        const reply = qoderReplies.length ? qoderReplies.shift() : "";
        if (reply) child.stdout.write(reply);
        setImmediate(() => child.emit("close", 0));
        return child;
    };

    // ---- 2. 打桩 app，再加载分发器 + 私聊处理器 ----
    const sent = [];
    const fakeClient = {
        on() {},
        sendText(to, text) { sent.push({ to, text }); },
        displayName(wxid) { return "昵称_" + wxid; },
    };
    const appFile = require.resolve("../app");
    require.cache[appFile] = { id: appFile, filename: appFile, loaded: true, exports: { client: fakeClient } };

    const admin = require("../state/admin");
    const dispatch = require("../dispatch");
    require("../message/private");
    const onPrivate = dispatch.handlers.private;
    check("私聊处理器已注册到分发器", typeof onPrivate === "function");

    async function send(wxid, text) {
        const replies = [];
        onPrivate({
            sender: { user_id: wxid },
            message: [{ type: "text", text }],
            reply: (t) => replies.push(String(t)),
        });
        await sleep(60);
        return replies;
    }
    async function waitIdle() {
        for (let i = 0; i < 300; i++) {
            if (!admin.queue.running && !admin.queue.list.length) return;
            await sleep(20);
        }
        throw new Error("任务队列 6s 没排空");
    }

    // ---- 3. 群里彻底不接管理员终端 ----
    const groupSrc = fs.readFileSync(path.join(ROOT, "message", "group.js"), "utf8");
    check("group.js 不再引用管理员终端", !/handleAdminMessage|state\/admin/.test(groupSrc));
    check("adminIndex 已启用", require("../command/admin/adminIndex").isEnabled() === true);

    // ---- 4. 非管理员私聊一律沉默 ----
    {
        const r1 = await send("wxid_guest", "你好");
        await waitIdle();
        check("非管理员说普通话不回", r1.length === 0, JSON.stringify(r1));
        const r2 = await send("wxid_guest", "cc帮我删库");
        await waitIdle();
        check("非管理员发 cc 也不执行、不回", r2.length === 0, JSON.stringify(r2));
    }

    // ---- 5. 暗号进入 ----
    const PHRASE = "沐水智天下第一帅";
    {
        const r = await send("wxid_a", PHRASE);
        check("暗号开启管理员模式", admin.isAdmin("wxid_a"), JSON.stringify(r));
        check("开启提示说明 cc 规则", r[0] && r[0].includes("cc") && r[0].includes("只聊天"), r[0]);
        const again = await send("wxid_a", PHRASE);
        check("已进入时再发暗号不重复加人", again[0] && again[0].includes("已经在"), again[0]);
        check("名单落盘", JSON.parse(fs.readFileSync(TMP_ADMIN, "utf8")).admins.includes("wxid_a"));
    }

    // ---- 6. 不带 cc：只聊天，不动电脑 ----
    {
        qoderReplies.push("这是聊天回复");
        const r = await send("wxid_a", "今天天气怎么样");
        await waitIdle();
        check("普通消息走对话", r[0] === "这是聊天回复", JSON.stringify(r));
        check("对话写进共享上下文", admin.state.conv.some((c) => c.role === "user" && c.content === "今天天气怎么样"));
    }

    // ---- 7. cc 开头：操作电脑（工具循环）----
    {
        sent.length = 0;
        qoderReplies.push(JSON.stringify({ tool: "read", path: "package.json" }));
        qoderReplies.push(JSON.stringify({ tool: "done", summary: "读完了 package.json" }));
        const r = await send("wxid_a", "cc读一下 package.json");
        await waitIdle();
        check("cc 任务先回开始提示", r[0] && r[0].includes("电脑操作任务已开始"), r[0]);
        check("cc 任务回执行结果", r[1] && r[1].includes("【电脑操作】") && r[1].includes("读完了"), r[1]);
        check("cc 任务也发汇报", sent.some((s) => s.text.includes("【管理员终端汇报】")));
    }
    {
        const r = await send("wxid_a", "cc");
        await waitIdle();
        check("只有 cc 没任务时给例子", r[0] && r[0].includes("后面要带任务"), r[0]);
    }

    // ---- 8. 元命令：带不带 cc 都认 ----
    {
        const r = await send("wxid_a", "cc帮助");
        await waitIdle();
        check("cc帮助给出新说明", r[0] && r[0].includes("cc退出") && r[0].includes("只在私聊"), r[0]);
        const r2 = await send("wxid_a", "切换模型");
        await waitIdle();
        check("切换模型列选项", r2[0] && r2[0].includes("可选模型"), r2[0]);
        const r3 = await send("wxid_a", "1");
        await waitIdle();
        check("回复数字切换模型", r3[0] && r3[0].includes("已切换到"), r3[0]);
    }

    // ---- 9. cc退出 ----
    {
        const r = await send("wxid_a", "cc退出");
        await waitIdle();
        check("cc退出摘掉管理员", !admin.isAdmin("wxid_a"), JSON.stringify(r));
        check("退出提示给了暗号", r[0] && r[0].includes(PHRASE), r[0]);
        const after = await send("wxid_a", "还在吗");
        await waitIdle();
        check("退出后私聊不再处理", after.length === 0, JSON.stringify(after));
        const rejoin = await send("wxid_a", PHRASE);
        check("可以再发暗号重新进入", admin.isAdmin("wxid_a") && rejoin[0].includes("管理员模式已开启"), rejoin[0]);
    }

    try { fs.unlinkSync(TMP_ADMIN); fs.unlinkSync(TMP_STATE); } catch (err) { /* 忽略 */ }
    console.log(failures ? "\n" + failures + " 项失败" : "\n全部通过");
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error("测试炸了: " + err.message);
    process.exit(1);
});
