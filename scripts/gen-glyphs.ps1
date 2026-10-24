# Generate 32x32 bitmap glyphs for Chinese chess pieces from SimHei.
# Output: D:\wechat-bot\command\xiangqi\glyphs.js
# Run: powershell -NoProfile -ExecutionPolicy Bypass -File scripts/gen-glyphs.ps1
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

# 0x8F66=che 0x9A6C=ma 0x76F8=xiang 0x8C61=xiang(b) 0x4ED5=shi 0x58EB=shi(b)
# 0x5E05=shuai 0x5C06=jiang 0x70AE=pao 0x5175=bing 0x5352=zu
# 0x695A=chu 0x6CB3=he 0x6C49=han 0x754C=jie
$cps = 0x8F66,0x9A6C,0x76F8,0x8C61,0x4ED5,0x58EB,0x5E05,0x5C06,0x70AE,0x5175,0x5352,0x695A,0x6CB3,0x6C49,0x754C
$size = 32
$fontSize = 26

$lines = New-Object System.Collections.Generic.List[string]
$lines.Add('"use strict";')
$lines.Add('// 32x32 bitmap glyphs rasterized from SimHei by scripts/gen-glyphs.ps1.')
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
    for ($y = 0; $y -lt $size; $y++) {
        $val = 0
        for ($x = 0; $x -lt $size; $x++) {
            $p = $bmp.GetPixel($x, $y)
            if (($p.R + $p.G + $p.B) -lt 384) { $val = $val -bor (1 -shl (31 - $x)) }
        }
        $rows.Add(('0x{0:X8}' -f $val))
    }
    $bmp.Dispose()
    $lines.Add('    "' + $ch + '": [' + ($rows -join ', ') + '],')
}
$lines.Add('};')
$lines.Add('module.exports = { GLYPHS };')

$outDir = 'D:\wechat-bot\command\xiangqi'
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
[System.IO.File]::WriteAllLines('D:\wechat-bot\command\xiangqi\glyphs.js', $lines)
Write-Output ("glyphs.js written: " + (Get-Item 'D:\wechat-bot\command\xiangqi\glyphs.js').Length + " bytes")
