# Reads one generic Windows Credential Manager entry and writes its UTF-8 blob to stdout.
# The caller keeps the value in memory only; nothing is written to disk.
param([Parameter(Mandatory = $true)][string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace PoolCred -Name Native -MemberDefinition @'
[StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
public struct CREDENTIAL {
  public int Flags; public int Type; public string TargetName; public string Comment;
  public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
  public int CredentialBlobSize; public IntPtr CredentialBlob; public int Persist;
  public int AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
}
[DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
[DllImport("advapi32.dll")]
public static extern void CredFree(IntPtr credential);
'@
$pointer = [IntPtr]::Zero
if (-not [PoolCred.Native]::CredRead($Target, 1, 0, [ref]$pointer)) { exit 2 }
try {
  $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][PoolCred.Native+CREDENTIAL])
  $bytes = New-Object byte[] $credential.CredentialBlobSize
  [Runtime.InteropServices.Marshal]::Copy($credential.CredentialBlob, $bytes, 0, $bytes.Length)
  [Console]::OpenStandardOutput().Write($bytes, 0, $bytes.Length)
} finally { [PoolCred.Native]::CredFree($pointer) }
