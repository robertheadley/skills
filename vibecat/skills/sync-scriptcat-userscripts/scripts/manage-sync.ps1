param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'status', 'health', 'stop')]
    [string]$Action,
    [string]$ProjectPath = 'D:\AI\AIProjects\userscript development sync',
    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
$cli = Join-Path $ProjectPath 'bin\vibecat.js'
if (-not (Test-Path -LiteralPath $cli -PathType Leaf)) { throw "VibeCat CLI not found: $cli" }
$command = if ($Action -eq 'health') { 'status' } else { $Action }
$arguments = @($cli, $command, '--project', $ProjectPath, '--json')
if ($ScriptPath) { $arguments += @('--file', $ScriptPath) }
& node @arguments
exit $LASTEXITCODE
