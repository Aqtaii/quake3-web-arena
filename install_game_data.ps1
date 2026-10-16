param([Parameter(Mandatory = $true)][string]$Source)

# Copy user-owned data only. Never download data or execute an installer.
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$sourceRoot = (Resolve-Path -LiteralPath $Source).Path
$pak0 = Join-Path $sourceRoot 'pak0.pk3'
if (!(Test-Path -LiteralPath $pak0 -PathType Leaf)) { throw 'Source must be the baseq3 directory containing pak0.pk3.' }
$archive = [IO.Compression.ZipFile]::OpenRead($pak0)
try {
    $entries = @{}
    foreach ($entry in $archive.Entries) { $entries[$entry.FullName.ToLowerInvariant()] = $entry.Length }
    foreach ($required in @('default.cfg', 'maps/q3dm1.bsp', 'models/players/sarge/lower.md3')) {
        if (!$entries.ContainsKey($required)) { throw "pak0.pk3 is missing required game data: $required" }
    }
    if ($entries['maps/q3dm1.bsp'] -eq 20032 -and $entries['botfiles/weapons.c'] -eq 16) {
        throw 'This is the generated demonstration package, not the original game data.'
    }
} finally { $archive.Dispose() }

$packages = @(Get-ChildItem -LiteralPath $sourceRoot -File | Where-Object { $_.Name -match '^pak[0-9]+\.pk3$' } | Sort-Object Name)
$destination = Join-Path $PSScriptRoot 'web/baseq3'
$null = New-Item -ItemType Directory -Force -Path $destination
foreach ($package in $packages) {
    # Check every ZIP before changing the web manifest.
    $testArchive = [IO.Compression.ZipFile]::OpenRead($package.FullName)
    $testArchive.Dispose()
}
foreach ($package in $packages) {
    $target = Join-Path $destination $package.Name.ToLowerInvariant()
    if (![string]::Equals([IO.Path]::GetFullPath($target), $package.FullName, [StringComparison]::OrdinalIgnoreCase)) {
        Copy-Item -LiteralPath $package.FullName -Destination $target -Force
    }
}
$manifest = @{ packages = @($packages | ForEach-Object { $_.Name.ToLowerInvariant() }) } | ConvertTo-Json
[IO.File]::WriteAllText((Join-Path $PSScriptRoot 'web/game-data.json'), $manifest, [Text.UTF8Encoding]::new($false))
Write-Host "Installed $($packages.Count) local game-data packages. Reload http://127.0.0.1:8080/"
