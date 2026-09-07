param(
    [Parameter(Mandatory = $true)][int]$ProcessId,
    [ValidateSet('Select', 'Cancel')][string]$Action = 'Select',
    [string]$PathsJson = '[]'
)
$ErrorActionPreference = 'Stop'
$stage = 'initialize'
try {
    Add-Type -AssemblyName UIAutomationClient
    Add-Type -AssemblyName UIAutomationTypes
    Add-Type @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PdfPicker {
  [DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint process);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] public static extern IntPtr SetText(IntPtr window, uint message, IntPtr param, string text);
  [DllImport("user32.dll", EntryPoint = "SendMessageW", CharSet = CharSet.Unicode)] public static extern IntPtr ReadText(IntPtr window, uint message, IntPtr count, StringBuilder text);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
}
'@
    $stage = 'paths'
    $paths = ConvertFrom-Json -InputObject $PathsJson
    if ($Action -eq 'Select') {
        if ($paths.Count -eq 0) { throw 'No fixtures supplied' }
        foreach ($path in $paths) {
            if (-not [IO.Path]::IsPathRooted($path) -or $path.Contains('"') -or
                [IO.Path]::GetFullPath($path) -cne $path -or
                -not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'Invalid fixture path' }
        }
    }
    $stage = 'dialog'
    $app = Get-Process -Id $ProcessId
    $deadline = [DateTime]::UtcNow.AddSeconds(15)
    $picker = $null
    do {
        $app.Refresh()
        if ($app.HasExited) { throw 'Test app exited' }
        if ($app.MainWindowHandle -ne [IntPtr]::Zero) {
            # Reacquire UIA on every poll: dialogs may be absent from an older tree.
            $reader = [System.Windows.Automation.AutomationElement]::FromHandle($app.MainWindowHandle)
            $windows = $reader.FindAll([System.Windows.Automation.TreeScope]::Children,
                [System.Windows.Automation.Condition]::TrueCondition)
            foreach ($window in $windows) {
                if ($window.Current.ControlType -ne [System.Windows.Automation.ControlType]::Window -or
                    $window.Current.Name -ne 'Open PDFs') { continue }
                $handle = [IntPtr]$window.Current.NativeWindowHandle
                [uint32]$ownerProcess = 0
                [PdfPicker]::GetWindowThreadProcessId($handle, [ref]$ownerProcess) | Out-Null
                if ($ownerProcess -eq $ProcessId -and
                    [PdfPicker]::GetWindow($handle, 4) -eq $app.MainWindowHandle) {
                    $picker = [System.Windows.Automation.AutomationElement]::FromHandle($handle)
                    break
                }
            }
        }
        if ($null -ne $picker) { break }
        Start-Sleep -Milliseconds 100
    } while ([DateTime]::UtcNow -lt $deadline)
    if ($null -eq $picker) { throw 'Owned native picker unavailable' }

    function Find-Control([string]$id, [string]$className) {
        $controls = $picker.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            [System.Windows.Automation.PropertyCondition]::new(
                [System.Windows.Automation.AutomationElement]::AutomationIdProperty, $id))
        foreach ($control in $controls) {
            $handle = [IntPtr]$control.Current.NativeWindowHandle
            if ($handle -eq [IntPtr]::Zero) { continue }
            $name = [Text.StringBuilder]::new(256)
            [uint32]$controlProcess = 0
            [PdfPicker]::GetWindowThreadProcessId($handle, [ref]$controlProcess) | Out-Null
            [PdfPicker]::GetClassName($handle, $name, $name.Capacity) | Out-Null
            if ($controlProcess -eq $ProcessId -and $name.ToString() -ceq $className) { return $handle }
        }
        throw 'Required native picker control unavailable'
    }
    if ($Action -eq 'Select') {
        $stage = 'filename'
        $field = Find-Control '1148' 'Edit'
        $value = ($paths | ForEach-Object { '"' + $_ + '"' }) -join ' '
        [PdfPicker]::SetText($field, 0x000C, [IntPtr]::Zero, $value) | Out-Null
        # GetWindowText cannot read another process's edit text. WM_GETTEXT can.
        $actual = [Text.StringBuilder]::new($value.Length + 1)
        [PdfPicker]::ReadText($field, 0x000D, [IntPtr]$actual.Capacity, $actual) | Out-Null
        if ($actual.ToString() -cne $value) { throw 'Exact filename verification failed' }
        $button = Find-Control '1' 'Button'
    } else {
        $button = Find-Control '2' 'Button'
    }
    $stage = 'button'
    if (-not [PdfPicker]::PostMessage($button, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)) {
        throw 'Native picker button failed'
    }
    exit 0
} catch {
    # Neither exception details nor UI strings/fixture paths belong in test logs.
    [Console]::Error.WriteLine("Native picker automation failed at $stage (details suppressed).")
    exit 1
}
