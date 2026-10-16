# Use the unmodified demo media with the source tree's 1.32 game code.
# The only override is id's own bot inventory header; no replacement artwork.
$ErrorActionPreference = 'Stop'
& (Join-Path $PSScriptRoot 'install_game_data.ps1') -Source (Join-Path $PSScriptRoot 'build/demo-data/demoq3')
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceHeader = [IO.File]::ReadAllText((Join-Path $PSScriptRoot 'Quake-III-Arena/code/game/inv.h'))
$sourceHeader = [regex]::Replace($sourceHeader, '(?m)^#define WEAPONINDEX_[^\r\n]*\r?\n', '')
$overlay = Join-Path $PSScriptRoot 'web/baseq3/pak9.pk3'
$stream = [IO.File]::Open($overlay, [IO.FileMode]::Create)
$zip = [IO.Compression.ZipArchive]::new($stream, [IO.Compression.ZipArchiveMode]::Create)
try {
    $entry = $zip.CreateEntry('botfiles/inv.h')
    $writer = [IO.StreamWriter]::new($entry.Open(), [Text.UTF8Encoding]::new($false))
    try { $writer.Write($sourceHeader) } finally { $writer.Dispose() }
    $entry = $zip.CreateEntry('COPYING.txt')
    $output = $entry.Open()
    $input = [IO.File]::OpenRead((Join-Path $PSScriptRoot 'Quake-III-Arena/COPYING.txt'))
    try { $input.CopyTo($output) } finally { $input.Dispose(); $output.Dispose() }
} finally { $zip.Dispose(); $stream.Dispose() }
Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'build/demo-data/Help/Q3A_EULA.txt') -Destination (Join-Path $PSScriptRoot 'web/baseq3/DEMO-LICENSE.txt') -Force
$manifest = @{ packages = @('pak0.pk3', 'pak9.pk3'); edition = 'demo'; source = 'Quake III Arena Demo 1.11, original media with source inventory compatibility header' } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'web/game-data.json'), $manifest, [Text.UTF8Encoding]::new($false))
Write-Host 'Original demo media prepared. No downloaded executable or QVM is used.'
