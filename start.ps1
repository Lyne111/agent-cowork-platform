$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw 'Please install Node.js 24.22.1 or a newer Node 24 release, then reopen PowerShell.'
}
& node scripts/check-prerequisites.mjs
if ($LASTEXITCODE -ne 0) { throw 'Node.js or Git prerequisite check failed.' }
if (-not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) { throw 'npm.cmd was not found.' }
& npm.cmd ci
if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed.' }
& npm.cmd run build
if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }
& npm.cmd run doctor
if ($LASTEXITCODE -ne 0) { throw 'Agent tool diagnostics failed.' }
& npm.cmd start
exit $LASTEXITCODE
