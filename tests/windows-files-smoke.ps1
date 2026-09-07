param([string]$Root = "$PSScriptRoot\..", [switch]$InteractiveConfirmed)
$ErrorActionPreference = "Stop"
if (-not $InteractiveConfirmed) {
    throw 'This smoke test takes keyboard focus. Announce it and use an idle desktop, then pass -InteractiveConfirmed. Do not use the picker during the test.'
}
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms
Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class SmokeFocus {
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr window);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] public static extern IntPtr ReadText(IntPtr window, uint message, IntPtr count, StringBuilder text);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr window, uint message, IntPtr wParam, string lParam);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@

function Find-Named($parent, [string]$name) {
    $parent.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::NameProperty, $name))
}
function Wait-TextStart([string]$prefix) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        $script:app.Refresh()
        if ($script:app.HasExited) { throw 'Test app exited' }
        $script:reader = [System.Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)
        $nodes = $script:reader.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.Condition]::TrueCondition)
        foreach ($node in $nodes) {
            if ($node.Current.Name -like ($prefix + '*')) { return }
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Expected app text not found: $prefix"
}
function Wait-Text([string]$text) {
    $deadline = [DateTime]::UtcNow.AddSeconds(20)
    do {
        Start-Sleep -Milliseconds 250
        $script:app.Refresh()
        if ($script:app.HasExited) { throw 'Test app exited' }
        $script:reader = [System.Windows.Automation.AutomationElement]::FromHandle($script:app.MainWindowHandle)
        $node = Find-Named $script:reader $text
        if ($null -ne $node) { return }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw "Expected app text not found: $text"
}
function Send-AppKeys([string]$keys) {
    (New-Object -ComObject WScript.Shell).AppActivate($script:app.Id) | Out-Null
    Start-Sleep -Milliseconds 300
    [uint32]$owner = 0
    [SmokeFocus]::GetWindowThreadProcessId([SmokeFocus]::GetForegroundWindow(), [ref]$owner) | Out-Null
    if ($owner -ne $script:app.Id) { throw "Refusing to send keys outside the test app (foreground $owner, expected $($script:app.Id))" }
    [System.Windows.Forms.SendKeys]::SendWait($keys)
}
function Wait-Picker {
    $deadline = [DateTime]::UtcNow.AddSeconds(10)
    do {
        Start-Sleep -Milliseconds 250
        $windows = $script:reader.FindAll([System.Windows.Automation.TreeScope]::Children,
            [System.Windows.Automation.Condition]::TrueCondition)
        $picker = $windows | Where-Object {
            $_.Current.ControlType -eq [System.Windows.Automation.ControlType]::Window -and $_.Current.Name -eq 'Open PDFs'
        } | Select-Object -First 1
        if ($null -ne $picker) {
            $script:picker = $picker
            [SmokeFocus]::SetForegroundWindow([IntPtr]$picker.Current.NativeWindowHandle) | Out-Null
            Start-Sleep -Milliseconds 250
            return
        }
    } while ([DateTime]::UtcNow -lt $deadline)
    throw 'Native Open PDFs dialog did not appear as an owned window'
}

function Find-PickerControl([string]$id, [string]$className) {
    $controls = $script:picker.FindAll([System.Windows.Automation.TreeScope]::Descendants,
        [System.Windows.Automation.PropertyCondition]::new(
            [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id))
    foreach ($control in $controls) {
        $handle = [IntPtr]$control.Current.NativeWindowHandle
        if ($handle -eq [IntPtr]::Zero) { continue }
        $name = [System.Text.StringBuilder]::new(256)
        [SmokeFocus]::GetClassName($handle, $name, $name.Capacity) | Out-Null
        if ($name.ToString() -eq $className) { return $handle }
    }
    throw "Native picker control not found: $className / $id"
}

function Set-PickerFiles([string[]]$paths) {
    $field = Find-PickerControl '1148' 'Edit'
    $value = ($paths | ForEach-Object { '"' + [System.IO.Path]::GetFullPath($_) + '"' }) -join ' '
    # Set the native edit control directly; never type into a remembered folder/list.
    [SmokeFocus]::SendMessage($field, 0x000C, [IntPtr]::Zero, $value) | Out-Null
    $actual = [System.Text.StringBuilder]::new($value.Length + 1)
    [SmokeFocus]::ReadText($field, 0x000D, [IntPtr]$actual.Capacity, $actual) | Out-Null
    if ($actual.ToString() -ne $value) { throw 'Picker filename field does not contain the exact fixture paths; refusing Open' }
}

function Click-PickerButton([string]$id) {
    $button = Find-PickerControl $id 'Button'
    if (-not [SmokeFocus]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw 'Could not click native picker button'
    }
}

$app = $null
$oldArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
try {
    foreach ($fixture in @('basic.pdf', 'navigation.pdf')) {
        if (-not (Test-Path -LiteralPath "$Root\fixtures\pdfs\$fixture" -PathType Leaf)) {
            throw "Missing generated fixture: fixtures/pdfs/$fixture. Sync the fixture corpus before testing."
        }
    }
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--force-renderer-accessibility'
    $app = Start-Process "$Root\src-tauri\target\release\local-pdf-reader.exe" -PassThru
    Start-Sleep -Seconds 3
    $app.Refresh()
    $reader = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
    Wait-Text 'No document open.'
    Wait-Text 'Press Ctrl+O to open a PDF.'
    [SmokeFocus]::SetForegroundWindow($app.MainWindowHandle) | Out-Null
    Start-Sleep -Milliseconds 250
    Send-AppKeys '^o'
    Wait-Picker
    $basic = [System.IO.Path]::GetFullPath("$Root\fixtures\pdfs\basic.pdf")
    $navigation = [System.IO.Path]::GetFullPath("$Root\fixtures\pdfs\navigation.pdf")
    Set-PickerFiles @($basic, $navigation)
    Click-PickerButton '1'
    Wait-TextStart 'basic.pdf'
    Wait-TextStart 'navigation.pdf'
    Send-AppKeys '^o'
    Wait-Picker
    Click-PickerButton '2'
    Wait-TextStart 'basic.pdf'
    Send-AppKeys ':'
    Wait-Text 'Command'
    Send-AppKeys 'q'
    Send-AppKeys '{ENTER}'
    Wait-Text 'No document open.'
    if (-not $app.CloseMainWindow()) { throw 'Close failed' }
    if (-not $app.WaitForExit(5000)) { throw 'App did not exit' }
    'PASS: Ctrl+O picker, multi-tab open, cancellation preserves tabs, :q close, clean exit'
} finally {
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $oldArguments
    if ($null -ne $app) {
        $app.Refresh()
        if (-not $app.HasExited) { $app.Kill() }
        $app.Dispose()
    }
}
