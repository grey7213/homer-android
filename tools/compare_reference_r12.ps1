# Compare the measured empty creator screen, excluding only the Android status bar.
# Differences are reported, not treated as proof of pixel identity.
Add-Type -AssemblyName System.Drawing
$taskRoot=Split-Path -Parent $PSScriptRoot
$taskOutput=Join-Path $taskRoot 'output/ui-models-r12'
$taskReference=[System.Drawing.Bitmap]::new((Join-Path $taskOutput 'tavo-creator-native.png'))
$taskActual=[System.Drawing.Bitmap]::new((Join-Path $taskOutput 'creator-android-r12.png'))
$taskWidth=1080
$taskHeight=2094
$taskScaled=[System.Drawing.Bitmap]::new($taskWidth,$taskHeight)
$taskGraphics=[System.Drawing.Graphics]::FromImage($taskScaled)
$taskGraphics.DrawImage($taskActual,0,0,$taskWidth,$taskHeight)
$taskGraphics.Dispose()
$taskDifference=[System.Drawing.Bitmap]::new($taskWidth,$taskHeight)
$taskChanged=0L
$taskError=0L
try {
    for($taskY=0;$taskY -lt $taskHeight;$taskY++) {
        for($taskX=0;$taskX -lt $taskWidth;$taskX++) {
            $taskA=$taskReference.GetPixel($taskX,$taskY+66)
            $taskB=$taskScaled.GetPixel($taskX,$taskY)
            $taskDelta=[Math]::Max([Math]::Abs([int]$taskA.R-[int]$taskB.R),[Math]::Max([Math]::Abs([int]$taskA.G-[int]$taskB.G),[Math]::Abs([int]$taskA.B-[int]$taskB.B)))
            $taskError+=$taskDelta
            if($taskDelta -gt 20) {$taskChanged++;$taskDifference.SetPixel($taskX,$taskY,[System.Drawing.Color]::FromArgb(225,45,70))}
            else {$taskDifference.SetPixel($taskX,$taskY,[System.Drawing.Color]::FromArgb(242,242,242))}
        }
    }
    $taskDifference.Save((Join-Path $taskOutput 'creator-pixel-diff.png'),[System.Drawing.Imaging.ImageFormat]::Png)
    $taskReport=[ordered]@{comparison='Native creator content vs installed WebView, 440 dpi';width=$taskWidth;height=$taskHeight;threshold=20;changedPixelRatio=$taskChanged/($taskWidth*$taskHeight);meanMaxChannelError=$taskError/($taskWidth*$taskHeight);intentionalDifferences=@('Original avatar vector, no proprietary image','Extra tools menu for existing Homer actions','Opening message remains optional');unresolved=@('Text rasterization and weight','Exact gradient and fine spacing');pixelIdentical=$false}
    $taskReport | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $taskOutput 'creator-pixel-diff.json') -Encoding utf8
    $taskReport | ConvertTo-Json -Depth 4
} finally {$taskReference.Dispose();$taskActual.Dispose();$taskScaled.Dispose();$taskDifference.Dispose()}
