$ErrorActionPreference='Stop'
$r20Root='C:/CodexWork/homer-community-r9'
$r20Export=Join-Path $r20Root 'output/ui-r20/patch-export'
New-Item -ItemType Directory -Path $r20Export -Force | Out-Null
$r20Index=Join-Path $r20Export 'index'
$r20Base=Join-Path $r20Export 'baseline-index'
$r20Patch=Join-Path $r20Root 'web-patches/20260919-ui-r20-dark-creator-points.patch'
Copy-Item -LiteralPath (Join-Path $r20Root 'output/ui-r19/patch-export/baseline-index') -Destination $r20Index
$r20PreviousIndex=$env:GIT_INDEX_FILE
try {
 $env:GIT_INDEX_FILE=$r20Index
 git -C "$r20Root/.web-cache/tree" apply --cached "$r20Root/web-patches/20260919-ui-r19-actual-controls-learning.patch"
 if($LASTEXITCODE -ne 0){throw 'R19 baseline failed'}
 Copy-Item -LiteralPath $r20Index -Destination $r20Base
 git -C "$r20Root/.web-cache/tree" -c core.safecrlf=false add -N -- frontend sillytavern-runtime
 if($LASTEXITCODE -ne 0){throw 'Intent to add failed'}
 git -C "$r20Root/.web-cache/tree" diff --binary --full-index "--output=$r20Patch"
 if($LASTEXITCODE -ne 0){throw 'Export failed'}
 Copy-Item -LiteralPath $r20Base -Destination $r20Index
 git -C "$r20Root/.web-cache/tree" apply --cached --check $r20Patch
 if($LASTEXITCODE -ne 0){throw 'R20 patch verification failed'}
 Write-Output 'R20 incremental patch verified with isolated index; real staging untouched.'
} finally {$env:GIT_INDEX_FILE=$r20PreviousIndex}
