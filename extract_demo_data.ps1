# Read the downloaded archive as bytes. Never invoke its shell stub or setup.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Formats.Tar
$archivePath = Join-Path $PSScriptRoot 'build/downloads/linuxq3ademo-1.11-6.x86.gz.sh'
$expectedHash = '64DEE3F69B6E792D1DA4FE0AC98FEDC7EB1E37EA1027FB609A9FADD06150A4EC'
if ((Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash -ne $expectedHash) {
    throw 'Archive differs from the downloaded file that was inspected.'
}
$outputRoot = Join-Path $PSScriptRoot 'build/demo-data'
$allowed = @('demoq3/pak0.pk3', 'Help/Q3A_EULA.txt', 'Help/Q3A_EULA.html', 'Help/Readme.html', 'README')
$extracted = @()
$inputStream = [IO.File]::OpenRead($archivePath)
try {
    # The inspected Makeself header says skip=165: gzip starts after 164 LF bytes.
    $lines = 0
    while ($lines -lt 164) {
        $byte = $inputStream.ReadByte()
        if ($byte -lt 0) { throw 'Incomplete archive header.' }
        if ($byte -eq 10) { $lines++ }
    }
    $gzip = [IO.Compression.GZipStream]::new($inputStream, [IO.Compression.CompressionMode]::Decompress, $true)
    $tar = [System.Formats.Tar.TarReader]::new($gzip, $true)
    try {
        while ($null -ne ($entry = $tar.GetNextEntry())) {
            if ($entry.Name -cnotin $allowed) { continue }
            if ($entry.EntryType.ToString() -notin @('RegularFile', 'V7RegularFile')) { throw 'Unexpected entry type.' }
            # Targets come exclusively from the exact allowlist above.
            $target = Join-Path $outputRoot $entry.Name
            $null = New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($target)) -Force
            $output = [IO.File]::Open($target, [IO.FileMode]::Create)
            try { $entry.DataStream.CopyTo($output) } finally { $output.Dispose() }
            $extracted += $entry.Name
            Write-Host "Extracted data only: $($entry.Name) ($($entry.Length) bytes)"
        }
    } finally { $tar.Dispose(); $gzip.Dispose() }
} finally { $inputStream.Dispose() }
foreach ($required in $allowed) {
    if ($required -cnotin $extracted) { throw "Missing expected entry: $required" }
}
Write-Host 'No downloaded script, installer, executable, DLL, shared library or game module was executed.'
