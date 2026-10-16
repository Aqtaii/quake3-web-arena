param(
    [string]$LlvmBin = 'D:\Tools\psemu-build\llvm-20.1.8\clang+llvm-20.1.8-x86_64-pc-windows-msvc\bin'
)

# Native Windows orchestration; uses only the already installed LLVM tools.
# All sources are rebuilt so header changes cannot leave stale objects behind.
$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$code = Join-Path $root 'Quake-III-Arena/code'
$build = Join-Path $root 'build'
$include = Join-Path $root 'src/include'
$clang = Join-Path $LlvmBin 'clang.exe'
$linker = Join-Path $LlvmBin 'wasm-ld.exe'
$nm = Join-Path $LlvmBin 'llvm-nm.exe'
foreach ($tool in @($clang, $linker, $nm)) {
    if (!(Test-Path -LiteralPath $tool -PathType Leaf)) { throw "Missing existing tool: $tool" }
}

# Keep source manifests shared with the previous build; do not execute Python.
$manifest = Get-Content (Join-Path $root 'build_wasm.py') -Raw
function Get-Sources([string]$name) {
    $match = [regex]::Match($manifest, '(?ms)^' + $name + ' = \[(.*?)^\]')
    if (!$match.Success) { throw "Missing source manifest: $name" }
    @([regex]::Matches($match.Groups[1].Value, '"([^"\r\n]+\.c)"') | ForEach-Object { $_.Groups[1].Value })
}

$flags = @('--target=wasm32-unknown-unknown', '-std=gnu89', '-O2',
    '-fsigned-char', '-fno-strict-aliasing', '-fno-builtin', '-Wno-everything',
    '-D__linux__', '-DC_ONLY', '-DBOTLIB', "-I$include")

function Compile-Sources([string[]]$sources, [string]$sourceRoot, [string]$group, [string[]]$extraFlags = @()) {
    $directory = Join-Path $build $group
    $null = New-Item -ItemType Directory -Force -Path $directory
    foreach ($relative in $sources) {
        $source = Join-Path $sourceRoot $relative
        $object = Join-Path $directory ($relative.Replace('/', '_') + '.o')
        & $clang @flags @extraFlags -c $source -o $object
        if ($LASTEXITCODE -ne 0) { throw "Compile failed: $source" }
        $object
    }
}

function Compile-Module([string]$name, [string]$listName) {
    $sources = Get-Sources $listName
    Write-Host "Building $name (raw symbols)..."
    $raw = @(Compile-Sources $sources $code ($name + '_raw'))
    $symbols = & $nm --defined-only -g @raw
    if ($LASTEXITCODE -ne 0) { throw "Symbol scan failed: $name" }
    $names = @($symbols | ForEach-Object {
        if ($_ -match '^\s*[0-9a-fA-F]+\s+[A-Za-z]\s+(\S+)\s*$') { $Matches[1] }
    } | Sort-Object -Unique)
    if (!$names.Count) { throw "No module symbols found: $name" }
    $header = Join-Path $build ($name + '_prefix.h')
    $lines = @("/* Generated symbol namespace for $name */")
    $lines += @($names | ForEach-Object { "#define $_ ${name}_$_" })
    [IO.File]::WriteAllLines($header, $lines, [Text.UTF8Encoding]::new($false))
    Write-Host "Building $name ($($names.Count) prefixed symbols)..."
    Compile-Sources $sources $code ($name + '_pref') @('-include', $header)
}

Write-Host 'Building engine and platform...'
$objects = @(Compile-Sources (Get-Sources 'ENGINE_SOURCES') $code 'engine')
$objects += @(Compile-Sources (Get-Sources 'WASM_SOURCES') (Join-Path $root 'src/wasm') 'wasm' @('-std=gnu99', "-I$code/unix", "-I$code"))
$objects += @(Compile-Module 'qagame' 'QAGAME_SOURCES')
$objects += @(Compile-Module 'cgame' 'CGAME_SOURCES')
$objects += @(Compile-Module 'ui' 'UI_SOURCES')
$output = Join-Path $root 'web/quake3.wasm'
$pending = Join-Path $build 'quake3.pending.wasm'
Write-Host "Linking $($objects.Count) objects..."
& $linker --no-entry --export-dynamic --export=__stack_pointer -z stack-size=8388608 --initial-memory=134217728 --max-memory=536870912 -o $pending @objects
if ($LASTEXITCODE -ne 0) { throw 'WASM link failed; existing web output preserved.' }
Copy-Item -LiteralPath $pending -Destination $output -Force
Write-Host "Built $output ($((Get-Item -LiteralPath $output).Length) bytes)"
