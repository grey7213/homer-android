$ErrorActionPreference='Stop'
$r22Root='C:/CodexWork/homer-community-r9'
$r22Export=Join-Path $r22Root 'output/ui-r22/patch-export'
New-Item -ItemType Directory -Path $r22Export -Force | Out-Null
$r22Index=Join-Path $r22Export 'index'
$r22Base=Join-Path $r22Export 'baseline-index'
$r22Patch=Join-Path $r22Root 'web-patches/20260919-ui-r22-admin-search-memory.patch'
Copy-Item -LiteralPath (Join-Path $r22Root 'output/ui-r21/patch-export/baseline-index') -Destination $r22Index
$r22PreviousIndex=$env:GIT_INDEX_FILE
try {
 $env:GIT_INDEX_FILE=$r22Index
 git -C "$r22Root/.web-cache/tree" apply --cached "$r22Root/web-patches/20260919-ui-r21-memory-notices-compose.patch"
 if($LASTEXITCODE -ne 0){throw 'R21 baseline failed'}
 Copy-Item -LiteralPath $r22Index -Destination $r22Base
 git -C "$r22Root/.web-cache/tree" -c core.safecrlf=false add -N -- frontend sillytavern-runtime
 if($LASTEXITCODE -ne 0){throw 'Intent to add failed'}
 git -C "$r22Root/.web-cache/tree" diff --binary --full-index "--output=$r22Patch"
 if($LASTEXITCODE -ne 0){throw 'Export failed'}
 Copy-Item -LiteralPath $r22Base -Destination $r22Index
 git -C "$r22Root/.web-cache/tree" apply --cached --check $r22Patch
 if($LASTEXITCODE -ne 0){throw 'R22 patch verification failed'}
 Write-Output 'R22 incremental patch verified; real staging untouched.'
} finally {$env:GIT_INDEX_FILE=$r22PreviousIndex}
