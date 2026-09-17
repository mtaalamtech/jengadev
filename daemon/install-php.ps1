param(
    [Parameter(Mandatory=$true)]
    [string]$ZipPath,
    [Parameter(Mandatory=$true)]
    [string]$TargetFolder
)

# The daemon downloads and checksum-verifies the zip itself (see
# downloadWithChecksum in index.js) before ever calling this script, so this
# only extracts and configures an already-verified local file - it doesn't
# fetch anything from the network on its own.
$ErrorActionPreference = 'Stop'

Write-Host "Extracting $ZipPath to $TargetFolder ..."
New-Item -ItemType Directory -Force -Path $TargetFolder | Out-Null
Expand-Archive -Path $ZipPath -DestinationPath $TargetFolder -Force

Write-Host "Configuring php.ini ..."
$iniDev = Join-Path $TargetFolder "php.ini-development"
$ini = Join-Path $TargetFolder "php.ini"

if (Test-Path $iniDev) {
    Copy-Item $iniDev -Destination $ini -Force
    $content = Get-Content $ini
    $content = $content -replace ";extension_dir = `"ext`"", "extension_dir = `"ext`""
    $content = $content -replace ";extension=curl", "extension=curl"
    $content = $content -replace ";extension=mysqli", "extension=mysqli"
    $content = $content -replace ";extension=mbstring", "extension=mbstring"
    $content = $content -replace ";extension=openssl", "extension=openssl"
    $content = $content -replace ";extension=pdo_mysql", "extension=pdo_mysql"
    $content = $content -replace ";extension=pgsql", "extension=pgsql"
    $content = $content -replace ";extension=pdo_pgsql", "extension=pdo_pgsql"
    $content = $content -replace ";cgi.fix_pathinfo=1", "cgi.fix_pathinfo=1"
    $content = $content -replace ";fastcgi.impersonate=1", "fastcgi.impersonate=1"
    Set-Content -Path $ini -Value $content
}

Write-Host "PHP Setup Complete."
