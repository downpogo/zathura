param(
    [string]$Executable = "$PSScriptRoot\..\src-tauri\target\release\local-pdf-reader.exe"
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$previousArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$app = $null
try {
    # Enable the accessibility tree for this test process only, not shipped config.
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--force-renderer-accessibility"
    $app = Start-Process -FilePath $Executable -PassThru
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    $names = @()
    do {
        Start-Sleep -Milliseconds 500
        $app.Refresh()
        if ($app.HasExited) { throw "Reader exited before smoke check" }
        if ($app.MainWindowHandle -eq 0) { continue }
        $root = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
        $nodes = $root.FindAll(
            [System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition
        )
        $names = @($nodes | ForEach-Object { $_.Current.Name })
    } while (($names -notcontains "No document open.") -and ([DateTime]::UtcNow -lt $deadline))

    if ($app.MainWindowTitle -ne "Zathura") { throw "Unexpected window title" }
    if (-not $app.Responding) { throw "Reader is not responding" }
    if ($names -notcontains "No document open.") { throw "Bundled reader content did not load" }
    if (-not $app.CloseMainWindow()) { throw "Window close failed" }
    if (-not $app.WaitForExit(5000)) { throw "Reader did not exit after close" }
    if ($app.ExitCode -ne 0) { throw "Reader returned a nonzero exit code" }
    "PASS: native Windows title, responsiveness, bundled empty-state content, and clean close"
} finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $previousArguments
    if ($null -ne $app) {
        $app.Refresh()
        if (-not $app.HasExited) { $app.Kill() }
        $app.Dispose()
    }
}
