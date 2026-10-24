"use strict";
const P = require("./pngread");
const img = P.read(process.argv[2]);
const hex = (c) => "#" + c.map((v) => v.toString(16).padStart(2, "0")).join("");
for (const arg of process.argv.slice(3)) {
    const [name, xy] = arg.split("=");
    const [x, y] = xy.split(",").map(Number);
    const c = img.rgb(x, y);
    console.log(name.padEnd(14) + " (" + x + "," + y + ")  rgb(" + c.join(",") + ")  " + hex(c));
}
