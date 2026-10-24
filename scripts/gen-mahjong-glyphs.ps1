# Generate 32x32 bitmap glyphs for mahjong tiles, rasterized from SimHei.
# Output: D:\wechat-bot\command\mahjong\glyphs.js
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-mahjong-glyphs.ps1
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# numbers + 萬 + suits + honors + UI labels + flowers (kept as codepoints so this file stays ASCII)
# 一二三四五六七八九 | 萬筒条 | 東南西北中發白 | 碰吃杠和缺庄立直自流局花 | 春夏秋冬梅兰竹菊
$cps = @(0x4E00,0x4E8C,0x4E09,0x56DB,0x4E94,0x516D,0x4E03,0x516B,0x4E5D,0x842C,0x7B52,0x6761,0x6771,0x5357,0x897F,0x5317,0x4E2D,0x767C,0x767D,0x78B0,0x5403,0x6760,0x548C,0x7F3A,0x5E84,0x7ACB,0x76F4,0x81EA,0x6D41,0x5C40,0x82B1,0x6625,0x590F,0x79CB,0x51AC,0x6885,0x5170,0x7AF9,0x83CA)
# labels the board renderer needs (mode names, seat names, counters, status words)
$cps += @(0x65E5,0x9EBB,0x8840,0x6218,0x5E7F,0x4E1C,0x7B2C,0x5BB6,0x98CE,0x5708,0x724C,0x4F59,0x5B9D,0x6307,0x793A,0x542C,0x5F85,0x5206,0x70B9,0x540D,0x72B6,0x6001,0x80E1,0x5C06,0x95E8,0x68D2,0x732A,0x987A,0x523B,0x5BF9,0x5F79,0x7FFB,0x500D,0x5E95,0x7ED3,0x7B97,0x6478,0x673A,0x5668,0x4EBA,0x7532,0x4E59,0x4E19,0x4E01,0x6C60,0x91CC,0x65E0,0x6709,0x73B0,0x7269,0x632F,0x8FC7,0x6253)
# board labels: 你 / 手牌张 / 副露 / 暗杠 / 下家
$cps += @(0x4F60,0x624B,0x5F20,0x526F,0x9732,0x6697,0x4E0B)
# 雀魂式牌桌要写的整句话：本棒/巡/牌山/血战到底/鸡平胡/等人表态/私聊已问/可以先看/刚打的/位置/次数/错误
$cps += @(0x672C,0x5DE1,0x5C71,0x5230,0x9E21,0x5E73,0x7B49,0x8868,0x79C1,0x804A,0x5DF2,0x95EE,0x8C01,0x8D62,0x8F93,0x5F00,0x59CB,0x52A0,0x597D,0x53CB,0x8981,0x660E,0x6CA1,0x5341,0x4E07,0x4E4B,0x95F4,0x62D4,0x8FD8,0x53EF,0x4EE5,0x80FD,0x4E0D,0x884C,0x5148,0x518D,0x770B,0x56FE,0x5728,0x4E86,0x7684,0x662F,0x8FD9,0x90A3,0x65F6,0x524D,0x540E,0x6211,0x6570,0x53F7,0x4F4D,0x6B21,0x521A,0x624D,0x9700,0x8BF7,0x9519,0x756A,0x4E0A,0x5C0F,0x5927,0x5B50,0x738B,0x674E,0x963F)
$size = 32
$fontSize = 26

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('"use strict";')
$lines.Add('// 32x32 bitmap glyphs for mahjong tiles, from scripts/gen-mahjong-glyphs.ps1 (SimHei).')
$lines.Add('// Each row is a 32-bit int, bit 31 = leftmost pixel.')
$lines.Add('const GLYPHS = {')
foreach ($cp in $cps) {
    $ch = [string][char][int]$cp
    $bmp = New-Object System.Drawing.Bitmap($size, $size)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::SingleBitPerPixelGridFit
    $g.Clear([System.Drawing.Color]::White)
    $font = New-Object System.Drawing.Font('SimHei', $fontSize, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
    $fmt = New-Object System.Drawing.StringFormat
    $fmt.Alignment = [System.Drawing.StringAlignment]::Center
    $fmt.LineAlignment = [System.Drawing.StringAlignment]::Center
    $rect = New-Object System.Drawing.RectangleF(0, 0, $size, $size)
    $g.DrawString($ch, $font, [System.Drawing.Brushes]::Black, $rect, $fmt)
    $g.Dispose()
    $rows = New-Object System.Collections.Generic.List[string]
    $ink = 0
    for ($y = 0; $y -lt $size; $y++) {
        $val = 0
        for ($x = 0; $x -lt $size; $x++) {
            $p = $bmp.GetPixel($x, $y)
            if (($p.R + $p.G + $p.B) -lt 384) { $val = $val -bor (1 -shl (31 - $x)); $ink++ }
        }
        $rows.Add(('0x{0:X8}' -f $val))
    }
    $bmp.Dispose()
    if ($ink -lt 20) { Write-Output ("WARN empty-ish glyph U+" + ('{0:X4}' -f $cp) + " ink=" + $ink) }
    $lines.Add(('    "' + $ch + '": [' + ($rows -join ', ') + '], // U+' + ('{0:X4}' -f $cp) + ' ink=' + $ink))
}
$lines.Add('};')
$lines.Add('module.exports = { GLYPHS };')

$outDir = 'D:\wechat-bot\command\mahjong'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
[System.IO.File]::WriteAllLines("$outDir\glyphs.js", $lines)
Write-Output ("glyphs.js written: " + (Get-Item "$outDir\glyphs.js").Length + " bytes, " + $cps.Count + " chars")
