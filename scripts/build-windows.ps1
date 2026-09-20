param(
    [string]$Destination = "$env:USERPROFILE\Downloads\Zathura.exe",
    [switch]$SkipSmoke,
    [switch]$Launch
)

$ErrorActionPreference = "Stop"
$Destination = [System.IO.Path]::GetFullPath($Destination)
$sourceRoot = Split-Path -Parent $PSScriptRoot
$stageRoot = Join-Path $env:TEMP "zathura-windows-build-$PID"
$artifact = Join-Path $stageRoot "src-tauri\target\release\local-pdf-reader.exe"
$candidate = "$Destination.new-$PID"
$backup = "$Destination.old-$PID"

function Invoke-Checked {
    param(
        [Parameter(Mandatory)] [string]$Command,
        [Parameter(ValueFromRemainingArguments)] [string[]]$Arguments
    )

    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Command failed with exit code $LASTEXITCODE"
    }
}

try {
    if (Test-Path -LiteralPath $stageRoot) {
        throw "Refusing to reuse staging directory: $stageRoot"
    }
    if (-not (Test-Path -LiteralPath (Split-Path -Parent $Destination) -PathType Container)) {
        throw "Destination directory does not exist: $(Split-Path -Parent $Destination)"
    }

    New-Item -ItemType Directory -Path $stageRoot | Out-Null
    & robocopy $sourceRoot $stageRoot /E /XD .git node_modules dist target src-tauri\target /XF *.local /NFL /NDL /NJH /NJS /NP
    if ($LASTEXITCODE -gt 7) {
        throw "robocopy failed with exit code $LASTEXITCODE"
    }

    Push-Location $stageRoot
    try {
        $package = Get-Content -LiteralPath "package.json" -Raw | ConvertFrom-Json
        $expectedPnpm = $package.packageManager -replace '^pnpm@', ''
        $actualPnpm = (& pnpm --version).Trim()
        if ($LASTEXITCODE -ne 0 -or $actualPnpm -ne $expectedPnpm) {
            throw "pnpm $expectedPnpm is required; found $actualPnpm"
        }

        $nodeVersion = [version]((& node --version).Trim().TrimStart('v'))
        if ($LASTEXITCODE -ne 0 -or $nodeVersion.Major -ne 24 -or $nodeVersion -lt [version]'24.14.0') {
            throw "Node.js >=24.14.0 <25 is required; found $nodeVersion"
        }

        Invoke-Checked -Command "pnpm" -Arguments @("install", "--frozen-lockfile")
        # Calling the CLI through node preserves the separator before Cargo's
        # --locked flag; pnpm's Windows shim consumes that separator.
        Invoke-Checked -Command "node" -Arguments @(
            "node_modules/@tauri-apps/cli/tauri.js",
            "build",
            "--no-bundle",
            "--",
            "--locked"
        )

        if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
            throw "Build artifact was not created: $artifact"
        }

        # Two processes with the same Tauri identity can interfere with the
        # smoke test, so close the installed copy only after compilation works.
        $running = @(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -eq $Destination })
        foreach ($item in $running) {
            $process = Get-Process -Id $item.ProcessId -ErrorAction SilentlyContinue
            if ($null -eq $process) { continue }
            if (-not $process.CloseMainWindow() -or -not $process.WaitForExit(10000)) {
                throw "Close the running Zathura process $($item.ProcessId) and retry"
            }
            $process.Dispose()
        }

        if (-not $SkipSmoke) {
            & (Join-Path $stageRoot "tests\windows-shell-smoke.ps1") -Executable $artifact
        }
    } finally {
        Pop-Location
    }

    Copy-Item -LiteralPath $artifact -Destination $candidate
    if (Test-Path -LiteralPath $Destination) {
        [System.IO.File]::Replace($candidate, $Destination, $backup)
        Remove-Item -LiteralPath $backup -Force
    } else {
        [System.IO.File]::Move($candidate, $Destination)
    }

    $sourceHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $artifact).Hash
    $destinationHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $Destination).Hash
    if ($sourceHash -ne $destinationHash) {
        throw "Destination hash does not match the build artifact"
    }

    $item = Get-Item -LiteralPath $Destination
    Write-Output "Built: $($item.FullName)"
    Write-Output "Bytes: $($item.Length)"
    Write-Output "SHA256: $destinationHash"

    if ($Launch) {
        Start-Process -FilePath $Destination | Out-Null
    }
} finally {
    if (Test-Path -LiteralPath $candidate) {
        Remove-Item -LiteralPath $candidate -Force
    }
    if (Test-Path -LiteralPath $backup) {
        Remove-Item -LiteralPath $backup -Force
    }
    if (Test-Path -LiteralPath $stageRoot) {
        Remove-Item -LiteralPath $stageRoot -Recurse -Force
    }
}
