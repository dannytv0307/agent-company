// Opens the operating system's own "choose a folder" dialog on the owner's desktop and returns the
// chosen path. Browsers never reveal a folder's real path, but this server runs on the same machine.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'

// Windows: the modern Explorer folder picker (IFileOpenDialog with FOS_PICKFOLDERS), shown on top of
// every window; falls back to the classic FolderBrowserDialog if COM is unavailable.
const WINDOWS_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class FolderPicker {
  [ComImport, Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7")] class FileOpenDialog {}
  [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IShellItem {
    void BindToHandler(); void GetParent();
    void GetDisplayName(uint sigdn, [MarshalAs(UnmanagedType.LPWStr)] out string name);
    void GetAttributes(); void Compare();
  }
  [ComImport, Guid("42f85136-db7e-439c-85f1-e4075d135fc8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IFileDialog {
    [PreserveSig] int Show(IntPtr parent);
    void SetFileTypes(); void SetFileTypeIndex(); void GetFileTypeIndex(); void Advise(); void Unadvise();
    void SetOptions(uint fos); void GetOptions(out uint fos);
    void SetDefaultFolder(); void SetFolder(IShellItem si); void GetFolder(); void GetCurrentSelection();
    void SetFileName(); void GetFileName();
    void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string title);
    void SetOkButtonLabel(); void SetFileNameLabel();
    void GetResult(out IShellItem si);
  }
  [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
  static extern void SHCreateItemFromParsingName(string path, IntPtr pbc, [MarshalAs(UnmanagedType.LPStruct)] Guid riid, out IShellItem item);
  public static string Pick(IntPtr owner, string title, string start) {
    var d = (IFileDialog)new FileOpenDialog();
    uint fos; d.GetOptions(out fos);
    d.SetOptions(fos | 0x20 | 0x40); // FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM
    d.SetTitle(title);
    if (!string.IsNullOrEmpty(start)) {
      try { IShellItem f; SHCreateItemFromParsingName(start, IntPtr.Zero, typeof(IShellItem).GUID, out f); d.SetFolder(f); } catch {}
    }
    if (d.Show(owner) != 0) return null;
    IShellItem r; d.GetResult(out r);
    string p; r.GetDisplayName(0x80058000, out p); // SIGDN_FILESYSPATH
    return p;
  }
}
'@
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true; $owner.ShowInTaskbar = $false; $owner.Opacity = 0
$owner.StartPosition = 'CenterScreen'; $owner.Size = New-Object System.Drawing.Size(1, 1)
$owner.Show(); $owner.Activate()
try {
  $path = [FolderPicker]::Pick($owner.Handle, $env:PICK_TITLE, $env:PICK_START)
} catch {
  $dlg = New-Object System.Windows.Forms.FolderBrowserDialog
  $dlg.Description = $env:PICK_TITLE
  if ($env:PICK_START) { $dlg.SelectedPath = $env:PICK_START }
  $path = if ($dlg.ShowDialog($owner) -eq 'OK') { $dlg.SelectedPath } else { $null }
}
$owner.Close()
if ($path) { [Console]::Out.Write($path) }
`

function command(title: string, start?: string): { bin: string; args: string[]; env?: Record<string, string> } {
  if (process.platform === 'win32') {
    // -EncodedCommand avoids every quoting problem: base64 of the UTF-16LE script.
    const encoded = Buffer.from(WINDOWS_SCRIPT, 'utf16le').toString('base64')
    return { bin: 'powershell.exe', args: ['-NoProfile', '-STA', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], env: { PICK_TITLE: title, PICK_START: start ?? '' } }
  }
  if (process.platform === 'darwin') {
    const from = start && existsSync(start) ? ` default location (POSIX file ${JSON.stringify(start)})` : ''
    return { bin: 'osascript', args: ['-e', `POSIX path of (choose folder with prompt ${JSON.stringify(title)}${from})`] }
  }
  return { bin: 'zenity', args: ['--file-selection', '--directory', `--title=${title}`, ...(start ? [`--filename=${start}/`] : [])] }
}

let open = false

/** The folder the owner chose, or null when they cancelled. One dialog at a time. */
export function pickFolder(title: string, start?: string): Promise<string | null> {
  if (open) return Promise.reject(new Error('A folder dialog is already open — look for it on your screen.'))
  open = true
  const { bin, args, env } = command(title, start)
  return new Promise<string | null>((resolve, reject) => {
    const child = spawn(bin, args, { env: { ...process.env, ...env }, windowsHide: false })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => reject(new Error(`Could not open a folder dialog (${e.message}). Type the path instead.`)))
    child.on('close', (code) => {
      const picked = out.trim().replace(/[\\/]$/, '')
      if (picked) resolve(picked)
      else if (code && err.trim() && !/cancel/i.test(err)) reject(new Error(`The folder dialog failed: ${err.trim().split('\n')[0]}`))
      else resolve(null)
    })
  }).finally(() => (open = false))
}
