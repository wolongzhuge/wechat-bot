"use strict";
// 只给探针脚本用的最小 PNG 解码器：8bit、非隔行、RGB/RGBA/灰度/调色板。
// 用途是把参考截图（雀魂网页、别的引擎出的图）读成像素，取准配色，
// 不打算做成通用库——遇到 16bit 或隔行直接报错，别默默给错颜色。

const fs = require("fs");
const zlib = require("zlib");

const SIG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function paeth(a, b, c) {
    const p = a + b - c;
    const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
    if (pa <= pb && pa <= pc) return a;
    if (pb <= pc) return b;
    return c;
}

function decode(buf) {
    for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) throw new Error("不是 PNG 文件");
    let pos = 8, ihdr = null, palette = null, trns = null;
    const idat = [];
    while (pos < buf.length) {
        const len = buf.readUInt32BE(pos);
        const type = buf.toString("ascii", pos + 4, pos + 8);
        const data = buf.slice(pos + 8, pos + 8 + len);
        pos += 12 + len;
        if (type === "IHDR") {
            ihdr = {
                w: data.readUInt32BE(0), h: data.readUInt32BE(4),
                depth: data[8], color: data[9], interlace: data[12],
            };
        } else if (type === "IDAT") idat.push(data);
        else if (type === "PLTE") palette = data;
        else if (type === "tRNS") trns = data;
        else if (type === "IEND") break;
    }
    if (!ihdr) throw new Error("没有 IHDR");
    if (ihdr.depth !== 8) throw new Error("只支持 8bit，这张是 " + ihdr.depth + "bit");
    if (ihdr.interlace) throw new Error("不支持隔行 PNG");
    const chans = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 }[ihdr.color];
    if (!chans) throw new Error("不认识的颜色类型 " + ihdr.color);

    const raw = zlib.inflateSync(Buffer.concat(idat));
    const stride = ihdr.w * chans;
    const out = Buffer.alloc(ihdr.h * stride);
    let p = 0;
    for (let y = 0; y < ihdr.h; y++) {
        const filter = raw[p++];
        const row = raw.slice(p, p + stride); p += stride;
        const cur = out.slice(y * stride, (y + 1) * stride);
        const prev = y ? out.slice((y - 1) * stride, y * stride) : Buffer.alloc(stride);
        for (let x = 0; x < stride; x++) {
            const a = x >= chans ? cur[x - chans] : 0;
            const b = prev[x];
            const c = x >= chans ? prev[x - chans] : 0;
            let v = row[x];
            if (filter === 1) v += a;
            else if (filter === 2) v += b;
            else if (filter === 3) v += (a + b) >> 1;
            else if (filter === 4) v += paeth(a, b, c);
            else if (filter !== 0) throw new Error("不认识的行过滤器 " + filter);
            cur[x] = v & 0xff;
        }
    }
    return {
        width: ihdr.w, height: ihdr.h, chans, color: ihdr.color, pixels: out, palette, trns,
        rgb(x, y) {
            const i = (y * this.width + x) * chans;
            if (ihdr.color === 3) {
                const idx = out[i] * 3;
                return [palette[idx], palette[idx + 1], palette[idx + 2]];
            }
            if (chans === 1 || chans === 2) return [out[i], out[i], out[i]];
            return [out[i], out[i + 1], out[i + 2]];
        },
    };
}

function read(file) { return decode(fs.readFileSync(file)); }

module.exports = { read, decode };
