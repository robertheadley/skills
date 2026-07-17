param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'status', 'health', 'stop')]
    [string]$Action,
    [string]$ProjectPath = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path,
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
$helper = Join-Path $ProjectPath 'skills\sync-scriptcat-userscripts\scripts\manage-sync.ps1'
if (-not (Test-Path -LiteralPath $helper -PathType Leaf)) {
    throw "Canonical VibeCat PowerShell manager not found: $helper"
}

& $helper -Action $Action -ProjectPath $ProjectPath -ScriptPath $ScriptPath
exit $LASTEXITCODE
