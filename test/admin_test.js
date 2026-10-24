"use strict";

// node test/admin_test.js
// 管理员模式隔离测试：stub 掉 app.js 和 qoder_api.js，不碰真实登录态、不连网络。
// state 文件都指到 test/ 下的临时文件，绝不碰 data/state.json 和 data/admin.json。

const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { EventEmitter } = require("events");
const { PassThrough } = require("stream");

const TMP_ADMIN = path.join(__dirname, "tmp-admin.json");
const TMP_STATE = path.join(__dirname, "tmp-state.json");
process.env.admin_state_file = TMP_ADMIN;
process.env.state_file = TMP_STATE;
for (const f of [TMP_ADMIN, TMP_ADMIN + ".tmp", TMP_STATE, TMP_STATE + ".tmp"]) {
    try { fs.unlinkSync(f); } catch (err) { /* 不存在就跳过 */ }
}

let failures = 0;
function check(name, cond) {
    if (cond) {
        console.log("PASS " + name);
    } else {
        failures++;
        console.error("FAIL " + name);
    }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
    // ---- 1. 打桩 child_process.spawn：记录参数 + 按脚本吐回复，全程无网络 ----
    const cp = require("child_process");
    const spawnCalls = [];
    let qoderReplies = [];
    const realSpawn = cp.spawn;
    cp.spawn = (bin, args, opts) => {
        // 只拦截 qoder cli 的调用；cc 的 run 工具要真执行命令
        if (bin !== (process.env.qoder_cli_bin || "qoderclicn")) return realSpawn(bin, args, opts);
        spawnCalls.push({ bin, args });
        const child = new EventEmitter();
        child.stdout = new PassThrough();
        child.stderr = new PassThrough();
        child.kill = () => {};
        const reply = qoderReplies.length ? qoderReplies.shift() : "";
        if (reply) child.stdout.write(reply);
        setImmediate(() => child.emit("close", 0));
        return child;
    };
    const realQoder = require("../api/qoder_api");
    await realQoder.runQoder("你好", { model: "qwen3.8max" });
    await realQoder.runQoder("你好");
    check("qoder_api 带模型时追加 -m 参数", JSON.stringify(spawnCalls[0].args) === JSON.stringify(["-p", "你好", "-m", "qwen3.8max"]));
    check("qoder_api 不带模型时只有 -p", JSON.stringify(spawnCalls[1].args) === JSON.stringify(["-p", "你好"]));

    // ---- 2. 打桩 app，再加载管理员模块（qoder_api 用真模块 + 假 spawn）----
    const sent = [];
    const fakeClient = {
        sendText(to, text) { sent.push({ to, text }); },
        displayName(wxid) { return "昵称_" + wxid; },
        on() {},
    };
    const appFile = require.resolve("../app");
    require.cache[appFile] = { id: appFile, filename: appFile, loaded: true, exports: { client: fakeClient } };

    const admin = require("../state/admin");
    const { handleAdminMessage, parseToolCall, executeTool } = require("../command/admin/adminIndex");

    const makeEvent = () => {
        const replies = [];
        return { replies, event: { reply: (t) => replies.push(String(t)) } };
    };
    async function waitIdle() {
        for (let i = 0; i < 500; i++) {
            if (!admin.queue.running && !admin.queue.list.length) return;
            await sleep(20);
        }
        throw new Error("任务队列 10s 没排空");
    }

    // ---- 3. 解锁与持久化 ----
    admin.addAdmin("wxid_a");
    check("解锁后 isAdmin", admin.isAdmin("wxid_a"));
    check("未解锁者不是管理员", !admin.isAdmin("wxid_b"));
    const persisted = JSON.parse(fs.readFileSync(TMP_ADMIN, "utf8"));
    check("管理员名单落盘", persisted.admins.includes("wxid_a"));

    // ---- 4. cc退出：从名单里摘掉 ----
    admin.removeAdmin("wxid_a");
    check("退出后不是管理员", !admin.isAdmin("wxid_a"));
    check("退出后名单也落盘", !JSON.parse(fs.readFileSync(TMP_ADMIN, "utf8")).admins.includes("wxid_a"));
    admin.addAdmin("wxid_a");

    // ---- 5. 切换模型 ----
    {
        const { replies, event } = makeEvent();
        handleAdminMessage(event, "切换模型", "wxid_a");
        await waitIdle();
        check("切换模型列出选项", replies[0] && replies[0].includes("可选模型"));
        check("等待选项状态置位", admin.state.awaitingModelChoice === true);
    }
    {
        const { replies, event } = makeEvent();
        handleAdminMessage(event, "2", "wxid_a");
        await waitIdle();
        check("回复数字切换到对应模型", admin.state.model === admin.models[1] && replies[0].includes("已切换到"));
        check("切完清除等待状态", admin.state.awaitingModelChoice === false);
    }
    {
        const { replies, event } = makeEvent();
        handleAdminMessage(event, "切换模型", "wxid_a");
        await waitIdle();
        handleAdminMessage(event, "999", "wxid_a");
        await waitIdle();
        check("无效选项不切换", replies[1].includes("没这个选项") && admin.state.model === admin.models[1]);
    }
    admin.setModel("qwen3.8max");

    // ---- 6. 改汇报时间 ----
    {
        const { replies, event } = makeEvent();
        handleAdminMessage(event, "改汇报时间 5", "wxid_a");
        await waitIdle();
        check("改汇报时间为 5 分钟", admin.state.reportIntervalMin === 5 && replies[0].includes("5 分钟"));
        handleAdminMessage(event, "改汇报时间", "wxid_a");
        await waitIdle();
        check("不带数字显示当前间隔", replies[1].includes("当前汇报间隔：5 分钟"));
        handleAdminMessage(event, "改汇报时间 10", "wxid_a");
        await waitIdle();
        check("改回 10 分钟", admin.state.reportIntervalMin === 10);
    }

    // ---- 7. 对话任务 + 完成即汇报 ----
    {
        sent.length = 0;
        qoderReplies.push("我是终端回复");
        const { replies, event } = makeEvent();
        handleAdminMessage(event, "你好", "wxid_a");
        await waitIdle();
        check("对话回复发给管理员", replies[0] === "我是终端回复");
        check("对话写进共享上下文", admin.state.conv.some((c) => c.role === "user" && c.content === "你好"));
        check("干完立刻汇报给所有管理员", sent.length === 1 && sent[0].text.includes("【管理员终端汇报】"));
    }

    // ---- 8. cc 电脑操作循环 ----
    {
        sent.length = 0;
        qoderReplies.push(JSON.stringify({ tool: "read", path: "package.json" }));
        qoderReplies.push(JSON.stringify({ tool: "done", summary: "已读取 package.json" }));
        const { replies, event } = makeEvent();
        handleAdminMessage(event, "cc读一下 package.json", "wxid_a");
        await waitIdle();
        check("cc 开局有确认回复", replies[0].includes("电脑操作任务已开始"));
        check("cc 完成有汇总回复", replies[1] && replies[1].includes("【电脑操作】"));
        check("cc 完成也汇报", sent.some((s) => s.text.includes("【管理员终端汇报】")));
    }

    // ---- 9. 工具：JSON 解析 / 工作区读写 / 越界拦截 / 跑命令 ----
    check("parseToolCall 剥代码围栏", parseToolCall('```json\n{"tool":"done"}\n```') && parseToolCall('```json\n{"tool":"done"}\n```').tool === "done");
    check("parseToolCall 宽松匹配", parseToolCall('前面废话 {"tool":"list","path":"."} 后面') && parseToolCall('前面废话 {"tool":"list","path":"."} 后面').tool === "list");
    check("parseToolCall 非 JSON 返回 null", parseToolCall("我直接说话") === null);

    const probeDir = path.join("test", ".tmp_admin_e2e");
    const writeRes = executeTool({ tool: "write", path: path.join(probeDir, "x.txt"), content: "hello 管理员" });
    check("write 工具写工作区文件", typeof writeRes === "string" && writeRes.includes("已写入"));
    const readRes = executeTool({ tool: "read", path: path.join(probeDir, "x.txt") });
    check("read 工具读回内容", readRes === "hello 管理员");
    const listRes = executeTool({ tool: "list", path: probeDir });
    check("list 工具列目录", String(listRes).includes("x.txt"));
    check("路径越界被拦截", String(executeTool({ tool: "read", path: "../../Windows/win.ini" })).includes("超出工作区"));
    const runRes = await executeTool({ tool: "run", cmd: "echo ADMIN_TOOL_OK" });
    check("run 工具执行命令", String(runRes).includes("ADMIN_TOOL_OK"));

    // ---- 10. reload 工具（最后跑：会整树重载 message/，用桩 app 无网络）----
    const reloadRes = executeTool({ tool: "reload" });
    check("reload 工具热更成功", String(reloadRes).includes("OK message\\group.js"));

    // ---- 清理 ----
    try { fs.rmSync(path.join(__dirname, "..", probeDir), { recursive: true, force: true }); } catch (err) {}
    try { fs.unlinkSync(TMP_ADMIN); fs.unlinkSync(TMP_STATE); } catch (err) {}

    console.log(failures ? "\n" + failures + " 项失败" : "\n全部通过");
    process.exit(failures ? 1 : 0);
}

main().catch((err) => {
    console.error("测试炸了: " + err.message);
    process.exit(1);
});
