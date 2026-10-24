"use strict";
// 管理员终端：只在私聊生效，所有管理员共享一个终端（对话上下文、任务队列钉在 state/admin.js）。
// cc 开头 = 操作电脑（读写文件/跑命令/热更，工作区 D:\wechat-bot），不带 cc = 只聊天。
// 本文件在热重载目录里，改逻辑 cc热更 即生效；状态和定时器不受影响。

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
// api/ 不在热重载目录里（reloader 只清 message/command/dou），这里手动清缓存拿最新版；
// qoder_api 无状态（纯 env 配置），重读安全，改它不用重启机器人
const qoderApiPath = require.resolve("../../api/qoder_api");
delete require.cache[qoderApiPath];
const { runQoder } = require(qoderApiPath);
const admin = require("../../state/admin");
const { client } = require("../../app");
const { reloadAll } = require("../../hot/reloader");

const ROOT = path.join(__dirname, "..", "..");
const MAX_TOOL_TURNS = 8;
const CMD_TIMEOUT_MS = parseInt(process.env.admin_cmd_timeout_ms || "60000", 10);

// 管理员模式总开关：只有私聊生效（message/group.js 不再把群消息交给终端）
const ENABLED = true;
function isEnabled() {
    return ENABLED;
}

// 定时器在 state/admin.js（钉住）里，这里注册汇报的生成与发送
admin.setReportHook(ENABLED ? () => sendReport(null) : null);

function handleAdminMessage(event, text, sender) {
    admin.queue.list.push({ event, text: String(text), sender: String(sender) });
    kick();
}

function kick() {
    if (admin.queue.running || !admin.queue.list.length) return;
    admin.queue.running = true;
    const task = admin.queue.list.shift();
    processTask(task)
        .catch((err) => task.event.reply("管理员终端出错：" + err.message))
        .finally(() => {
            admin.queue.running = false;
            kick();
        });
}

async function processTask({ event, text, sender }) {
    const t = text.trim();
    if (!t) return;

    const isCc = /^cc\s*/i.test(t);
    const meta = t.replace(/^cc\s*/i, "");

    if (meta === "帮助" || meta === "管理员帮助" || meta === "终端帮助") {
        event.reply(helpText());
        return;
    }
    if (meta.startsWith("切换模型")) {
        event.reply(showModelList());
        return;
    }
    if (meta.startsWith("改汇报时间")) {
        event.reply(setReportInterval(meta));
        return;
    }
    // 发过「切换模型」后下一条不带 cc 的消息当选项；带 cc 说明他要干活，别拦
    if (admin.state.awaitingModelChoice) {
        if (!isCc) {
            event.reply(trySwitchModel(t));
            return;
        }
        admin.setAwaitingModelChoice(false);
    }
    // cc 开头 = 操作电脑：走本地能力循环（读写文件 / 跑命令 / 热更）
    if (isCc) return runLocalLoop(event, meta, sender);
    // 不带 cc：只聊天，不动电脑
    return chatTask(event, t, sender);
}

async function chatTask(event, text, sender) {
    const prompt = buildPrompt(text);
    admin.pushConv("user", text);
    let reply;
    try {
        reply = cliHint((await runQoder(prompt, { model: admin.state.model })) || "(空回复)");
    } catch (err) {
        reply = "qoder cli 调用失败：" + err.message;
    }
    admin.pushConv("assistant", reply);
    admin.logTask(sender, "对话", text);
    event.reply(reply);
    sendReport({ from: sender, brief: text, result: reply.slice(0, 40) });
}

// CLI 没登录时会把这句英文当正常输出返回，补一句能照着做的中文
function cliHint(text) {
    const t = String(text || "");
    if (/not logged in/i.test(t)) {
        return t + "\n（Qoder CLI 还没登录：在电脑上跑一次 qoderclicn login，登录后重发一遍）";
    }
    return t;
}

// qoder cli 是一次性问答，把共享上下文压进 prompt；上限按字符掐，微信一条 2000 字会被切
function buildPrompt(text) {
    const persona = process.env.admin_system_role ||
        "你是微信机器人管理员的共享终端，管理员们通过微信和你对话来迭代机器人。用简洁口语化的中文回复，不要长篇大论。";
    const recent = admin.state.conv.slice(-12);
    let transcript = "";
    let budget = 6000;
    for (let i = recent.length - 1; i >= 0; i--) {
        const line = (recent[i].role === "user" ? "管理员: " : "终端: ") + recent[i].content + "\n";
        if (budget - line.length < 0) break;
        budget -= line.length;
        transcript = line + transcript;
    }
    return persona + "\n\n" + (transcript ? "前面的对话：\n" + transcript + "\n" : "") + "管理员现在说：" + text;
}

// ---- cc 电脑操作：工具循环 ----

async function runLocalLoop(event, taskText, sender) {
    if (!taskText) {
        event.reply("cc 后面要带任务，例如：cc看看 logs/bot.out 最后 20 行");
        return;
    }
    event.reply("电脑操作任务已开始：" + taskText + "（最多 " + MAX_TOOL_TURNS + " 轮工具调用，完成后汇报）");
    const observations = [];
    let final = "";
    for (let turn = 0; turn < MAX_TOOL_TURNS; turn++) {
        let out;
        try {
            out = await runQoder(toolPrompt(taskText, observations), { model: admin.state.model });
        } catch (err) {
            final = "qoder cli 调用失败：" + err.message;
            break;
        }
        const call = parseToolCall(out);
        if (!call) {
            final = cliHint(out);
            break;
        }
        if (call.tool === "done") {
            final = String(call.summary || out).slice(0, 500);
            break;
        }
        const result = executeTool(call);
        observations.push({ call, result });
    }
    if (!final) final = "达到 " + MAX_TOOL_TURNS + " 轮上限，任务停止。";
    const summary = "【电脑操作】" + final;
    admin.pushConv("assistant", summary.slice(0, 300));
    admin.logTask(sender, "操作", taskText);
    event.reply(summary);
    sendReport({ from: sender, brief: "cc " + taskText, result: final.slice(0, 40) });
}

function toolPrompt(task, observations) {
    const tools = [
        "run:{cmd} 在工作区执行 shell 命令",
        "read:{path} 读工作区内文件",
        "write:{path,content} 写/覆盖工作区内文件",
        "list:{path} 列目录",
        "reload:{} 热更机器人（改完代码用它生效）",
        "done:{summary} 完成并汇报",
    ].join("；");
    let obs = "";
    for (const o of observations.slice(-4)) {
        obs += "调用 " + JSON.stringify(o.call) + "\n结果：" + String(o.result).slice(0, 1200) + "\n\n";
    }
    return "你是机器人管理员的本地执行助手，工作区 " + ROOT + "。\n" +
        "任务：" + task + "\n" +
        "可用工具：" + tools + "。\n" +
        "只回复一个 JSON 对象，格式 {\"tool\":\"...\",...参数}，不要输出任何其他文字。" +
        (obs ? "\n\n已执行记录：\n" + obs : "");
}

function parseToolCall(out) {
    if (!out) return null;
    let s = out.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
    try {
        return JSON.parse(s);
    } catch (err) { /* 掉下去试宽松匹配 */ }
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
        try {
            return JSON.parse(m[0]);
        } catch (err) { /* 不是 JSON，当普通回复 */ }
    }
    return null;
}

function executeTool(call) {
    const tool = call && call.tool;
    try {
        if (tool === "run") return runCommand(String(call.cmd || ""));
        if (tool === "read") return readInWorkspace(String(call.path || ""));
        if (tool === "write") return writeInWorkspace(String(call.path || ""), String(call.content || ""));
        if (tool === "list") return listInWorkspace(String(call.path || "."));
        if (tool === "reload") return reloadAll().join("\n");
        return "未知工具：" + tool;
    } catch (err) {
        return tool + " 执行失败：" + err.message;
    }
}

// 文件类工具只许碰工作区，路径越界直接拦
function resolveIn(pathname) {
    const abs = path.resolve(ROOT, String(pathname));
    if (abs !== ROOT && !abs.startsWith(ROOT + path.sep)) throw new Error("路径超出工作区 " + ROOT);
    return abs;
}

function readInWorkspace(pathname) {
    const abs = resolveIn(pathname);
    return fs.readFileSync(abs, "utf8").slice(0, 4000);
}

function writeInWorkspace(pathname, content) {
    const abs = resolveIn(pathname);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content, "utf8");
    return "已写入 " + abs + "（" + content.length + " 字符）";
}

function listInWorkspace(pathname) {
    const abs = resolveIn(pathname);
    const names = fs.readdirSync(abs).slice(0, 100);
    return names.length ? names.join("\n") : "(空目录)";
}

function runCommand(cmd) {
    return new Promise((resolve) => {
        const child = spawn(cmd, { shell: true, cwd: ROOT, windowsHide: true });
        let out = "";
        const finish = (tail) => resolve(out.slice(0, 4000) + tail);
        const timer = setTimeout(() => {
            child.kill();
            finish("\n[命令超时 " + Math.round(CMD_TIMEOUT_MS / 1000) + "s 已终止]");
        }, CMD_TIMEOUT_MS);
        child.stdout.on("data", (b) => {
            out += b;
            if (out.length > 4000) {
                clearTimeout(timer);
                child.kill();
                finish("\n[输出截断]");
            }
        });
        child.stderr.on("data", (b) => (out += b));
        child.on("error", (err) => {
            clearTimeout(timer);
            finish("\n启动命令失败：" + err.message);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            finish(code ? "\n[退出码 " + code + "]" : "");
        });
    });
}

// ---- 切换模型 / 改汇报时间 / 帮助 ----

function showModelList() {
    admin.setAwaitingModelChoice(true);
    return "可选模型：\n" +
        admin.models.map((m, i) => (i + 1) + ". " + m + (m === admin.state.model ? "（当前）" : "")).join("\n") +
        "\n回复数字或模型名切换，例如回复 2。";
}

function trySwitchModel(t) {
    admin.setAwaitingModelChoice(false);
    let target = null;
    if (/^\d+$/.test(t)) {
        const i = parseInt(t, 10) - 1;
        if (i >= 0 && i < admin.models.length) target = admin.models[i];
    } else {
        target = admin.models.find((m) => m.toLowerCase() === t.toLowerCase());
    }
    if (!target) {
        return "没这个选项，当前模型：" + admin.state.model + "。发 切换模型 重新看列表。";
    }
    admin.setModel(target);
    return "已切换到 " + target + "。";
}

function setReportInterval(t) {
    const m = t.match(/(\d+)/);
    if (!m) {
        return "当前汇报间隔：" + admin.state.reportIntervalMin + " 分钟。改成：cc改汇报时间 5";
    }
    const n = parseInt(m[1], 10);
    if (n < 1 || n > 1440) {
        return "间隔要在 1-1440 分钟之间（比如 cc改汇报时间 5）。";
    }
    admin.setReportInterval(n);
    return "汇报间隔已改为 " + n + " 分钟，我会定期向所有管理员汇报工作情况。";
}

function helpText() {
    return "【管理员终端】只在私聊生效，所有管理员共享这一个终端。\n" +
        "cc 开头：操作电脑（读文件、跑命令、热更机器人），工作区 " + ROOT + "\n" +
        "不带 cc：只聊天，不动电脑（当前模型 " + admin.state.model + "）\n" +
        "切换模型：列出可选模型，回复数字或名称切换\n" +
        "改汇报时间 N：改汇报间隔（分钟），当前 " + admin.state.reportIntervalMin + " 分钟\n" +
        "cc退出：退出管理员模式（之后私聊不再处理，再发暗号可重新进入）\n" +
        "群里没有管理员终端，群里消息一律当普通聊天/玩法。";
}

// ---- 汇报 ----

function sendReport(doneTask) {
    const admins = admin.state.admins.slice();
    if (!admins.length) return;
    let body;
    if (doneTask) {
        body = "刚处理完一条任务：\n来自：" + client.displayName(doneTask.from) +
            "\n内容：" + doneTask.brief.slice(0, 60) + "\n结果：" + doneTask.result;
    } else {
        const since = admin.pendingTasksSince();
        body = "最近 " + admin.state.reportIntervalMin + " 分钟处理了 " + since.length + " 条任务" +
            (since.length ? "：\n" + since.slice(-3).map((t) => t.kind + "：" + t.brief.slice(0, 40)).join("\n") : "，一切正常");
    }
    admin.markReported();
    const tail = "当前模型：" + admin.state.model +
        "｜汇报间隔：" + admin.state.reportIntervalMin + " 分钟（cc改汇报时间 N 修改）";
    for (const wxid of admins) {
        client.sendText(wxid, "【管理员终端汇报】\n" + body + "\n" + tail);
    }
}

module.exports = { handleAdminMessage, parseToolCall, executeTool, isEnabled };
