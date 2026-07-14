param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('start', 'status', 'health', 'stop')]
    [string]$Action,

    [string]$ProjectPath = (Split-Path -Parent $PSScriptRoot),

    [string]$ScriptPath
)

$ErrorActionPreference = 'Stop'
$Port = 8642
$HostAddress = '127.0.0.1'

function Write-Result([object]$Value) {
    $Value | ConvertTo-Json -Depth 8 -Compress
}

function Get-Paths {
    $project = [IO.Path]::GetFullPath($ProjectPath)
    if (-not (Test-Path -LiteralPath $project -PathType Container)) {
        throw "Sync project not found: $project"
    }
    $server = Join-Path $project 'sync-server.js'
    if (-not (Test-Path -LiteralPath $server -PathType Leaf)) {
        throw "Sync server not found: $server"
    }
    $runtime = Join-Path $project '.runtime'
    [pscustomobject]@{
        Project = $project
        Server = $server
        Runtime = $runtime
        PidFile = Join-Path $runtime 'sync-server.pid'
        Stdout = Join-Path $runtime 'sync-server.stdout.log'
        Stderr = Join-Path $runtime 'sync-server.stderr.log'
        ActiveScript = Join-Path $runtime 'active-script.txt'
    }
}

function Get-VerifiedProcess($Paths) {
    if (-not (Test-Path -LiteralPath $Paths.PidFile -PathType Leaf)) { return $null }
    $savedPid = 0
    if (-not [int]::TryParse((Get-Content -Raw -LiteralPath $Paths.PidFile).Trim(), [ref]$savedPid)) { return $null }
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$savedPid" -ErrorAction SilentlyContinue
    if (-not $process) { return $null }
    if ($process.CommandLine -notmatch 'sync-server\.js') {
        throw "PID $savedPid exists but is not the ScriptCat sync server"
    }
    return $process
}

function Get-Health {
    try {
        return Invoke-RestMethod -Uri "http://${HostAddress}:${Port}/debug/health" -TimeoutSec 2
    } catch {
        return $null
    }
}

function Get-Status($Paths) {
    $process = Get-VerifiedProcess $Paths
    $listener = Get-NetTCPConnection -LocalAddress $HostAddress -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
    $health = Get-Health
    $activeScript = if (Test-Path -LiteralPath $Paths.ActiveScript) { (Get-Content -Raw -LiteralPath $Paths.ActiveScript).Trim() } elseif ($health) { $health.watched_file } else { $null }
    return [ordered]@{
        project_path = $Paths.Project
        running = [bool]$process
        pid = if ($process) { [int]$process.ProcessId } else { $null }
        process_started_at = if ($process) { ([datetime]$process.CreationDate).ToString('o') } else { $null }
        port = $Port
        port_owner_pid = if ($listener) { [int]$listener.OwningProcess } else { $null }
        active_script = $activeScript
        health = $health
        stdout_log = $Paths.Stdout
        stdout_last_write_at = if (Test-Path -LiteralPath $Paths.Stdout) { (Get-Item -LiteralPath $Paths.Stdout).LastWriteTime.ToString('o') } else { $null }
        stderr_log = $Paths.Stderr
        console_log = Join-Path $Paths.Runtime 'userscript-console.jsonl'
    }
}

function Write-AtomicText([string]$Path, [string]$Text) {
    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $temporary = Join-Path $directory ('.' + [IO.Path]::GetFileName($Path) + '.' + [guid]::NewGuid().ToString('N') + '.tmp')
    [IO.File]::WriteAllText($temporary, $Text, [Text.UTF8Encoding]::new($false))
    Move-Item -LiteralPath $temporary -Destination $Path -Force
}

$paths = Get-Paths

switch ($Action) {
    'status' {
        Write-Result (Get-Status $paths)
        break
    }
    'health' {
        $health = Get-Health
        if (-not $health) { throw "Sync health endpoint is unavailable at http://${HostAddress}:${Port}/debug/health" }
        Write-Result $health
        break
    }
    'start' {
        $existing = Get-VerifiedProcess $paths
        if ($existing) {
            Write-Result (Get-Status $paths)
            break
        }
        $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
        if ($listener) { throw "Port $Port is already owned by PID $($listener.OwningProcess)" }
        if (-not $ScriptPath) { throw 'ScriptPath is required when starting the server' }
        $resolvedScript = if ([IO.Path]::IsPathRooted($ScriptPath)) {
            [IO.Path]::GetFullPath($ScriptPath)
        } else {
            [IO.Path]::GetFullPath((Join-Path $paths.Project $ScriptPath))
        }
        if (-not (Test-Path -LiteralPath $resolvedScript -PathType Leaf)) { throw "Userscript not found: $resolvedScript" }
        if (-not $resolvedScript.EndsWith('.user.js', [StringComparison]::OrdinalIgnoreCase)) {
            throw "Expected an executable .user.js target, got: $resolvedScript"
        }
        $node = (Get-Command node -ErrorAction Stop).Source
        if (-not (Test-Path -LiteralPath (Join-Path $paths.Project 'node_modules\ws'))) {
            throw "Dependencies are missing. Run npm install in $($paths.Project)"
        }
        New-Item -ItemType Directory -Force -Path $paths.Runtime | Out-Null
        $arguments = @("`"$($paths.Server)`"", "`"$resolvedScript`"")
        $process = Start-Process -FilePath $node -ArgumentList $arguments -WorkingDirectory $paths.Project -WindowStyle Hidden -RedirectStandardOutput $paths.Stdout -RedirectStandardError $paths.Stderr -PassThru
        Write-AtomicText $paths.PidFile ([string]$process.Id)
        Write-AtomicText $paths.ActiveScript $resolvedScript
        $deadline = (Get-Date).AddSeconds(8)
        do {
            Start-Sleep -Milliseconds 100
            if ($process.HasExited) {
                $errorText = if (Test-Path -LiteralPath $paths.Stderr) { Get-Content -Raw -LiteralPath $paths.Stderr } else { '' }
                throw "Sync server exited with code $($process.ExitCode): $errorText"
            }
            $health = Get-Health
        } while (-not $health -and (Get-Date) -lt $deadline)
        if (-not $health) { throw 'Sync server started but health did not become available within 8 seconds' }
        Write-Result (Get-Status $paths)
        break
    }
    'stop' {
        $process = Get-VerifiedProcess $paths
        if ($process) {
            Stop-Process -Id $process.ProcessId
            Wait-Process -Id $process.ProcessId -Timeout 5 -ErrorAction SilentlyContinue
        }
        if (Test-Path -LiteralPath $paths.PidFile) { Remove-Item -LiteralPath $paths.PidFile -Force }
        Write-Result (Get-Status $paths)
        break
    }
}
