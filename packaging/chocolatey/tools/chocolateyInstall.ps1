$ErrorActionPreference = 'Stop'

$packageArgs = @{
  packageName    = 'jengadev'
  fileType       = 'exe'
  url64          = 'https://github.com/mtaalamtech/jengadev/releases/download/v1.0.25/JengaDev_Setup_Full_v1.0.25.exe'
  softwareName   = 'JengaDev*'
  checksum64     = 'A81B0F284C0DBACF6BDEC9321A6EAC6C233AC27EB0BF5383D23CC2EF5A2360A4'
  checksumType64 = 'sha256'
  # /SP- skips Inno's "This will install..." confirmation; the rest are the
  # standard Inno Setup unattended switches. The custom ports-configuration
  # wizard page is skipped entirely in silent mode and falls back to its
  # coded defaults (80/443/4000/3306/5432/9000/8025/1025).
  silentArgs     = '/SP- /VERYSILENT /SUPPRESSMSGBOXES /NORESTART'
  validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
