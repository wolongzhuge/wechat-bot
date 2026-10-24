Add-Type -AssemblyName System.Drawing
$path = "D:\wechat-bot\scripts\out\majsoul-live.png"
$bmp = [System.Drawing.Bitmap]::FromFile($path)
Write-Output ("SIZE " + $bmp.Width + "x" + $bmp.Height)
$pts = @{}
# 网格采样：每 80px 一个点，按颜色聚类找主色
$buckets = @{}
for ($y = 0; $y -lt $bmp.Height; $y += 8) {
  for ($x = 0; $x -lt $bmp.Width; $x += 8) {
    $c = $bmp.GetPixel($x, $y)
    $key = ("{0},{1},{2}" -f [math]::Floor($c.R/16)*16, [math]::Floor($c.G/16)*16, [math]::Floor($c.B/16)*16)
    if ($buckets.ContainsKey($key)) { $buckets[$key] = $buckets[$key] + 1 } else { $buckets[$key] = 1 }
  }
}
$buckets.GetEnumerator() | Sort-Object -Property Value -Descending | Select-Object -First 25 | ForEach-Object {
  Write-Output ("{0,-16} {1}" -f $_.Key, $_.Value)
}
$bmp.Dispose()
