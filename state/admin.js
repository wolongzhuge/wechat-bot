"use strict";
// 钉住的管理员终端状态：解锁名单、群里退出名单、共享对话、当前模型、汇报间隔、任务队列全在这。
// 持久化 data/admin.json —— 和 state.json 快照分开，清快照/换玩法都不丢管理员。
// 汇报定时器也只在这里起一次（钉住模块只加载一次，热重载不会挂两个）。

const fs = require("fs");
const path = require("path");
require("dotenv").config();

const FILE = process.env.admin_state_file || path.join(__dirname, "..", "data", "admin.json");
const DEFAULT_MODEL = process.env.admin_default_model || "Qwen3.8-Flash";
// 名字必须和 qoderclicn --list-models 输出一致，写错 CLI 会回一句降级警告，那句会被当成回答发出去
const MODELS = (process.env.admin_models || "Qwen3.8-Flash,DeepSeek-Flash")
    .split(",").map((s) => s.trim()).filter(Boolean);
const DEFAULT_INTERVAL = Math.min(1440, Math.max(1, parseInt(process.env.admin_report_interval_min || "10", 10) || 10));

function defaults() {
    return {
        admins: [],                 // 已进入管理员模式的 wxid
        model: DEFAULT_MODEL,
        reportIntervalMin: DEFAULT_INTERVAL,
        awaitingModelChoice: false, // 发了「切换模型」后，下一条消息当作选项处理
        conv: [],                   // 所有管理员共享的终端上下文 [{role, content}]
        taskLog: [],                // 工作情况 [{time, from, kind, brief}]，汇报用
        lastReportAt: 0,
    };
}

let lastWritten = "";

let state = defaults();
try {
    const loaded = JSON.parse(fs.readFileSync(FILE, "utf8"));
    state = Object.assign(defaults(), loaded);
} catch (err) {
    if (err.code !== "ENOENT") console.error("admin.json 读失败: " + err.message);
}
if (!Array.isArray(state.admins)) state.admins = [];
// 模型名改了（比如 CLI 那边换了可用模型）就落回第一个，并把修正写回文件，别让旧名字一直躺在 admin.json
if (!MODELS.includes(state.model)) {
    state.model = MODELS[0] || DEFAULT_MODEL;
    state.awaitingModelChoice = false;
    save();
}

function save() {
    try {
        const payload = JSON.stringify(state, null, 2);
        if (payload === lastWritten) return;
        fs.mkdirSync(path.dirname(FILE), { recursive: true });
        const tmp = FILE + ".tmp";
        fs.writeFileSync(tmp, payload);
        fs.renameSync(tmp, FILE);
        lastWritten = payload;
    } catch (err) {
        console.error("admin.json 保存失败: " + err.message);
    }
}

function isAdmin(wxid) {
    return state.admins.includes(String(wxid));
}

function addAdmin(wxid) {
    const w = String(wxid);
    if (!state.admins.includes(w)) {
        state.admins.push(w);
        save();
    }
}

// 退出管理员模式：从名单里摘掉，之后私聊不再走终端（再发暗号可重新进）
function removeAdmin(wxid) {
    const w = String(wxid);
    if (!state.admins.includes(w)) return false;
    state.admins = state.admins.filter((x) => x !== w);
    save();
    return true;
}

function setModel(model) {
    state.model = model;
    state.awaitingModelChoice = false;
    save();
}

function setReportInterval(min) {
    state.reportIntervalMin = min;
    save();
}

function setAwaitingModelChoice(on) {
    state.awaitingModelChoice = !!on;
    save();
}

function pushConv(role, content) {
    state.conv.push({ role, content: String(content) });
    if (state.conv.length > 40) state.conv = state.conv.slice(-40);
    save();
}

function logTask(wxid, kind, brief) {
    state.taskLog.push({ time: Date.now(), from: String(wxid), kind, brief: String(brief).slice(0, 60) });
    if (state.taskLog.length > 50) state.taskLog = state.taskLog.slice(-50);
    save();
}

function markReported() {
    state.lastReportAt = Date.now();
    save();
}

function pendingTasksSince() {
    return state.taskLog.filter((t) => t.time > state.lastReportAt);
}

// 共享终端任务队列：钉在这里，热重载不丢排队中的任务（处理函数由 command/admin 注册）
const queue = { running: false, list: [] };

// 汇报定时器：到点且有新工作情况才触发，钩子内容由 command/admin/adminIndex.js 注册
let reportHook = null;
function setReportHook(fn) {
    reportHook = fn;
}
setInterval(() => {
    if (!reportHook || !state.admins.length) return;
    if (Date.now() - state.lastReportAt >= state.reportIntervalMin * 60000
        && state.taskLog.some((t) => t.time > state.lastReportAt)) {
        reportHook();
    }
}, 30000);

module.exports = {
    state, models: MODELS,
    isAdmin, addAdmin, removeAdmin,
    setModel, setReportInterval, setAwaitingModelChoice,
    pushConv, logTask, markReported, pendingTasksSince,
    setReportHook, queue,
};
