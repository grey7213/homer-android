$ErrorActionPreference='Stop'
$r21Root='C:/CodexWork/homer-community-r9'
$r21Export=Join-Path $r21Root 'output/ui-r21/patch-export'
New-Item -ItemType Directory -Path $r21Export -Force | Out-Null
$r21Index=Join-Path $r21Export 'index'
$r21Base=Join-Path $r21Export 'baseline-index'
$r21Patch=Join-Path $r21Root 'web-patches/20260919-ui-r21-memory-notices-compose.patch'
Copy-Item -LiteralPath (Join-Path $r21Root 'output/ui-r20/patch-export/baseline-index') -Destination $r21Index
$r21PreviousIndex=$env:GIT_INDEX_FILE
try {
 $env:GIT_INDEX_FILE=$r21Index
 git -C "$r21Root/.web-cache/tree" apply --cached "$r21Root/web-patches/20260919-ui-r20-dark-creator-points.patch"
 if($LASTEXITCODE -ne 0){throw 'R20 baseline failed'}
 Copy-Item -LiteralPath $r21Index -Destination $r21Base
 git -C "$r21Root/.web-cache/tree" -c core.safecrlf=false add -N -- frontend sillytavern-runtime
 if($LASTEXITCODE -ne 0){throw 'Intent to add failed'}
 git -C "$r21Root/.web-cache/tree" diff --binary --full-index "--output=$r21Patch"
 if($LASTEXITCODE -ne 0){throw 'Export failed'}
 Copy-Item -LiteralPath $r21Base -Destination $r21Index
 git -C "$r21Root/.web-cache/tree" apply --cached --check $r21Patch
 if($LASTEXITCODE -ne 0){throw 'R21 patch verification failed'}
 Write-Output 'R21 incremental patch verified with isolated index; real staging untouched.'
} finally {$env:GIT_INDEX_FILE=$r21PreviousIndex}
