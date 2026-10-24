"use strict";
// 不引第三方依赖，直接手搓 PNG：IHDR + IDAT(zlib deflate 原始扫描线) + IEND。
// 五子棋要把盘面画成图片发群里，微信手机上文本棋盘必然错位，只有图片靠得住。

const zlib = require("zlib");

const CRC_TABLE = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[n] = c;
    }
    return t;
})();

function crc32(buf) {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

// rgb: Buffer(width*height*3)，逐行加 filter=0 字节后压缩
function encodePng(width, height, rgb) {
    if (rgb.length !== width * height * 3) throw new Error("rgb 长度不匹配");
    const stride = width * 3;
    const raw = Buffer.alloc((stride + 1) * height);
    for (let y = 0; y < height; y++) {
        raw[y * (stride + 1)] = 0; // None filter
        rgb.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
    }
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(width, 0);
    ihdr.writeUInt32BE(height, 4);
    ihdr[8] = 8;  // bit depth
    ihdr[9] = 2;  // color type: truecolor
    return Buffer.concat([
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        chunk("IHDR", ihdr),
        chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
        chunk("IEND", Buffer.alloc(0)),
    ]);
}

class Canvas {
    constructor(width, height, background) {
        this.width = width;
        this.height = height;
        this.px = Buffer.alloc(width * height * 3);
        if (background) this.clear(background);
    }

    clear([r, g, b]) {
        for (let i = 0; i < this.width * this.height; i++) {
            this.px[i * 3] = r;
            this.px[i * 3 + 1] = g;
            this.px[i * 3 + 2] = b;
        }
    }

    dot(x, y, [r, g, b]) {
        if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
        const i = (y * this.width + x) * 3;
        this.px[i] = r;
        this.px[i + 1] = g;
        this.px[i + 2] = b;
    }

    rect(x0, y0, x1, y1, color) {
        for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) {
            for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) this.dot(x, y, color);
        }
    }

    lineH(y, x0, x1, color) {
        for (let x = Math.max(0, x0); x <= Math.min(this.width - 1, x1); x++) this.dot(x, y, color);
    }

    lineV(x, y0, y1, color) {
        for (let y = Math.max(0, y0); y <= Math.min(this.height - 1, y1); y++) this.dot(x, y, color);
    }

    // 任意斜线（Bresenham），画九宫斜线用
    line(x0, y0, x1, y1, color) {
        const steep = Math.abs(y1 - y0) > Math.abs(x1 - x0);
        if (steep) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }
        if (x0 > x1) { [x0, x1] = [x1, x0]; [y0, y1] = [y1, y0]; }
        const dx = x1 - x0;
        const dy = Math.abs(y1 - y0);
        const ystep = y0 < y1 ? 1 : -1;
        let err = dx >> 1;
        let y = y0;
        for (let x = x0; x <= x1; x++) {
            if (steep) this.dot(y, x, color); else this.dot(x, y, color);
            err -= dy;
            if (err < 0) { y += ystep; err += dx; }
        }
    }

    // 实心圆，用来画棋子
    circle(cx, cy, radius, color) {
        const r2 = radius * radius;
        for (let dy = -radius; dy <= radius; dy++) {
            const w = Math.floor(Math.sqrt(r2 - dy * dy));
            for (let dx = -w; dx <= w; dx++) this.dot(cx + dx, cy + dy, color);
        }
    }

    // 8x8 点阵字体，只覆盖五子棋要用的字符，省得引字体库
    text(str, x0, y0, color, scale) {
        scale = scale || 2;
        let cursor = x0;
        for (const ch of String(str)) {
            const glyph = GLYPHS[ch] || GLYPHS["?"];
            for (let row = 0; row < 8; row++) {
                const bits = glyph[row];
                for (let col = 0; col < 8; col++) {
                    if (bits & (0x80 >> col)) {
                        this.rect(cursor + col * scale, y0 + row * scale,
                            cursor + col * scale + scale - 1, y0 + row * scale + scale - 1, color);
                    }
                }
            }
            cursor += 8 * scale + scale;
        }
    }

    toBuffer() {
        return encodePng(this.width, this.height, this.px);
    }
}

// 每行一个字节，高位在左
const GLYPHS = {
    "0": [0x1c, 0x22, 0x22, 0x22, 0x22, 0x22, 0x22, 0x1c],
    "1": [0x10, 0x30, 0x10, 0x10, 0x10, 0x10, 0x10, 0x38],
    "2": [0x3c, 0x42, 0x02, 0x04, 0x08, 0x10, 0x20, 0x7e],
    "3": [0x3c, 0x42, 0x02, 0x1c, 0x02, 0x02, 0x42, 0x3c],
    "4": [0x04, 0x0c, 0x14, 0x24, 0x7e, 0x04, 0x04, 0x04],
    "5": [0x7e, 0x40, 0x7c, 0x02, 0x02, 0x42, 0x42, 0x3c],
    "6": [0x38, 0x40, 0x7c, 0x42, 0x42, 0x42, 0x44, 0x38],
    "7": [0x7e, 0x02, 0x04, 0x08, 0x10, 0x10, 0x10, 0x10],
    "8": [0x3c, 0x42, 0x42, 0x3c, 0x42, 0x42, 0x42, 0x3c],
    "9": [0x3c, 0x42, 0x42, 0x46, 0x3a, 0x02, 0x02, 0x3c],
    "A": [0x3c, 0x42, 0x42, 0x7e, 0x42, 0x42, 0x42, 0x00],
    "B": [0x7c, 0x42, 0x42, 0x7c, 0x42, 0x42, 0x42, 0x7c],
    "C": [0x3c, 0x42, 0x40, 0x40, 0x40, 0x40, 0x42, 0x3c],
    "D": [0x7c, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x7c],
    "E": [0x7e, 0x40, 0x40, 0x78, 0x40, 0x40, 0x40, 0x7e],
    "F": [0x7e, 0x40, 0x40, 0x78, 0x40, 0x40, 0x40, 0x40],
    "G": [0x3c, 0x42, 0x40, 0x4e, 0x42, 0x42, 0x42, 0x3c],
    "H": [0x42, 0x42, 0x42, 0x7e, 0x42, 0x42, 0x42, 0x42],
    "I": [0x3e, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x3e],
    "J": [0x1f, 0x02, 0x02, 0x02, 0x02, 0x42, 0x42, 0x3c],
    "K": [0x42, 0x44, 0x48, 0x70, 0x48, 0x44, 0x42, 0x40],
    "L": [0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x40, 0x7e],
    "M": [0x42, 0x66, 0x5a, 0x5a, 0x42, 0x42, 0x42, 0x00],
    "N": [0x42, 0x62, 0x52, 0x4a, 0x46, 0x42, 0x42, 0x00],
    "O": [0x3c, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x3c],
    "P": [0x7c, 0x42, 0x42, 0x7c, 0x40, 0x40, 0x40, 0x40],
    "Q": [0x3c, 0x42, 0x42, 0x42, 0x4a, 0x44, 0x38, 0x10],
    "R": [0x7c, 0x42, 0x42, 0x7c, 0x48, 0x44, 0x42, 0x40],
    "S": [0x3e, 0x40, 0x40, 0x3c, 0x02, 0x02, 0x42, 0x3c],
    "T": [0x7f, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x10],
    "U": [0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x42, 0x3c],
    "V": [0x42, 0x42, 0x42, 0x42, 0x42, 0x24, 0x24, 0x18],
    "W": [0x42, 0x42, 0x42, 0x42, 0x5a, 0x66, 0x42, 0x00],
    "X": [0x42, 0x42, 0x24, 0x18, 0x24, 0x42, 0x42, 0x00],
    "Y": [0x41, 0x22, 0x14, 0x08, 0x08, 0x08, 0x08, 0x08],
    "Z": [0x7e, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x7e],
    " ": [0, 0, 0, 0, 0, 0, 0, 0],
    ":": [0, 0x18, 0x18, 0, 0x18, 0x18, 0, 0],
    "-": [0, 0, 0, 0x7e, 0, 0, 0, 0],
    "+": [0, 0x10, 0x10, 0x7f, 0x10, 0x10, 0, 0],
    "=": [0, 0x7e, 0, 0x7e, 0, 0, 0, 0],
    "/": [0x02, 0x04, 0x04, 0x08, 0x10, 0x10, 0x20, 0x20],
    "(": [0x08, 0x10, 0x20, 0x20, 0x20, 0x20, 0x10, 0x08],
    ")": [0x10, 0x08, 0x04, 0x04, 0x04, 0x04, 0x08, 0x10],
    "#": [0x14, 0x7f, 0x14, 0x14, 0x7f, 0x14, 0x00, 0x00],
    "?": [0x3c, 0x42, 0x02, 0x0c, 0x10, 0x00, 0x10, 0x00],
};

module.exports = { encodePng, Canvas };
