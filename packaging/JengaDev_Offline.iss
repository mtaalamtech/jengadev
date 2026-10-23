[Setup]
AppName=JengaDev
AppVersion=1.0.33
DefaultDirName=C:\JengaDev
DefaultGroupName=JengaDev
OutputDir=C:\Users\Admin\Desktop
OutputBaseFilename=JengaDev_Setup_Full_v1.0.33
Compression=lzma2/ultra
SolidCompression=yes
SetupIconFile=C:\safuweb\nexus\JengaDev.ico
UninstallDisplayIcon={app}\JengaDev.ico
PrivilegesRequired=admin
AppPublisher=Core Mtaalam Technologies
AppPublisherURL=https://mtaalamtech.com
AppSupportURL=https://mtaalamtech.com
AppUpdatesURL=https://mtaalamtech.com
LicenseFile=C:\safuweb\nexus\scratch\license.txt

[Tasks]
Name: "desktopicon"; Description: "Create a desktop shortcut"; GroupDescription: "Additional icons:"

[Files]
Source: "C:\safuweb\nexus\JengaDev.ico"; DestDir: "{app}"; Flags: ignoreversion
Source: "C:\JengaDev_Build\*"; DestDir: "{app}"; Flags: ignoreversion recursesubdirs createallsubdirs; Excludes: "JengaDev_Offline.iss"

[Icons]
; JengaDevTray.exe is the actual entry point now, not JengaDev.exe directly.
; It's a WinForms app (no console ever allocated, so no hidden-launcher
; trick is needed the way JengaDev.exe itself still needs one - see its own
; CreateNoWindow=true Process.Start call), and it's what gives JengaDev a
; persistent tray icon: double-clicking any of these shortcuts again while
; it's already running just reopens the dashboard instead of starting a
; second copy (see JengaDevTray.cs's single-instance mutex).
Name: "{group}\JengaDev"; Filename: "{app}\JengaDevTray.exe"; IconFilename: "{app}\JengaDev.ico"
Name: "{autodesktop}\JengaDev"; Filename: "{app}\JengaDevTray.exe"; Tasks: desktopicon; IconFilename: "{app}\JengaDev.ico"
Name: "{autostartup}\JengaDev"; Filename: "{app}\JengaDevTray.exe"; Parameters: "--silent"; IconFilename: "{app}\JengaDev.ico"

[Code]
function UpdateReadyMemo(Space, NewLine, MemoUserInfoInfo, MemoDirInfo, MemoTypeInfo, MemoComponentsInfo, MemoGroupInfo, MemoTasksInfo: String): String;
var
  S: String;
begin
  S := MemoDirInfo + NewLine + NewLine;
  
  S := S + 'The following components will be installed:' + NewLine;
  S := S + Space + '• JengaDev Core Engine & Dashboard' + NewLine;
  S := S + Space + '• Caddy Web Server' + NewLine;
  S := S + Space + '• PHP FastCGI' + NewLine;
  S := S + Space + '• MySQL (MariaDB 11.2)' + NewLine;
  S := S + Space + '• PostgreSQL 16.2' + NewLine;
  S := S + Space + '• SQLite' + NewLine;
  S := S + Space + '• phpMyAdmin & Adminer' + NewLine;
  S := S + Space + '• Mailpit (Local Email Tester)' + NewLine;
  
  Result := S;
end;

var
  PortsPage: TInputQueryWizardPage;

function IsUpgrade: Boolean;
begin
  Result := FileExists(ExpandConstant('{app}\JengaDev.exe'));
end;

procedure InitializeWizard;
begin
  PortsPage := CreateInputQueryPage(wpSelectDir,
    'Service Ports Configuration', 'Customize the ports for JengaDev services.',
    'Please specify the ports for the services. If you have another application (like XAMPP or Skype) using these ports, you can change them here.');
  PortsPage.Add('Caddy HTTP Port:', False);
  PortsPage.Add('Caddy HTTPS Port:', False);
  PortsPage.Add('Dashboard (Daemon) Port:', False);
  PortsPage.Add('MySQL / MariaDB Port:', False);
  PortsPage.Add('PostgreSQL Port:', False);
  PortsPage.Add('PHP FastCGI Port:', False);
  PortsPage.Add('Mailpit Web Port:', False);
  PortsPage.Add('Mailpit SMTP Port:', False);
  
  PortsPage.Values[0] := '80';
  PortsPage.Values[1] := '443';
  PortsPage.Values[2] := '4000';
  PortsPage.Values[3] := '3306';
  PortsPage.Values[4] := '5432';
  PortsPage.Values[5] := '9000';
  PortsPage.Values[6] := '8025';
  PortsPage.Values[7] := '1025';
end;

procedure StopJengaDevServices;
var
  ResultCode: Integer;
  PsCmd: String;
begin
  WizardForm.StatusLabel.Caption := 'Stopping background services for safe upgrade...';
  // "node" used to be in this list from when JengaDev.exe was launched as
  // bin\node\node.exe + a script argument - now that it's one pkg-compiled
  // exe, that entry would just kill every OTHER Node.js process on the
  // machine too (the user's own projects, editors, anything named node.exe),
  // which has nothing to do with JengaDev. Removed.
  Exec('powershell.exe', '-WindowStyle Hidden -Command "Stop-Process -Name JengaDev -Force -ErrorAction SilentlyContinue; Stop-Process -Name JengaDevTray -Force -ErrorAction SilentlyContinue; Stop-Process -Name caddy -Force -ErrorAction SilentlyContinue; Stop-Process -Name php-cgi -Force -ErrorAction SilentlyContinue; Stop-Process -Name mysqld -Force -ErrorAction SilentlyContinue; Stop-Process -Name postgres -Force -ErrorAction SilentlyContinue; Stop-Process -Name mailpit -Force -ErrorAction SilentlyContinue"', '', SW_HIDE, ewWaitUntilTerminated, ResultCode);

  // A flat 2-second sleep here wasn't always enough for MySQL/Postgres to
  // fully release their listening sockets after a forced kill, so the very
  // next page's port-conflict check (NextButtonClick) would sometimes still
  // see them as busy on the first "Next" click and reject it, needing a
  // second click a moment later once they'd actually let go. Actively poll
  // the configured ports instead of guessing a fixed delay.
  PsCmd := '-WindowStyle Hidden -Command "' +
    '$ports = @(' + PortsPage.Values[0] + ',' + PortsPage.Values[1] + ',' + PortsPage.Values[2] + ',' + PortsPage.Values[3] + ',' + PortsPage.Values[4] + ',' + PortsPage.Values[5] + ',' + PortsPage.Values[6] + ',' + PortsPage.Values[7] + '); ' +
    'for ($i = 0; $i -lt 16; $i++) { ' +
    '  $busy = $false; ' +
    '  foreach ($p in $ports) { if (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue) { $busy = $true; break } }; ' +
    '  if (-not $busy) { break }; ' +
    '  Start-Sleep -Milliseconds 500; ' +
    '}"';
  Exec('powershell.exe', PsCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
end;

function PrepareToInstall(var NeedsRestart: Boolean): String;
begin
  StopJengaDevServices;
  Result := '';
end;

function NextButtonClick(CurPageID: Integer): Boolean;
var
  ResultCode: Integer;
  PsCmd, P1, P2, P3, P4, P5, P6, P7, P8: String;
begin
  Result := True;
  
  if CurPageID = PortsPage.ID then
  begin
    P1 := PortsPage.Values[0];
    P2 := PortsPage.Values[1];
    P3 := PortsPage.Values[2];
    P4 := PortsPage.Values[3];
    P5 := PortsPage.Values[4];
    P6 := PortsPage.Values[5];
    P7 := PortsPage.Values[6];
    P8 := PortsPage.Values[7];
    
    WizardForm.StatusLabel.Caption := 'Checking ports...';
    PsCmd := '-WindowStyle Hidden -Command "$ports = @(' + P1 + ',' + P2 + ',' + P3 + ',' + P4 + ',' + P5 + ',' + P6 + ',' + P7 + ',' + P8 + '); $conflict = $false; foreach ($p in $ports) { $conn = Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue; if ($conn) { $conflict = $true; break; } }; if ($conflict) { exit 1 } else { exit 0 }"';
    Exec('powershell.exe', PsCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    
    if ResultCode = 1 then
    begin
      MsgBox('One or more of the selected ports are currently in use by another application. Please choose different ports.', mbError, MB_OK);
      Result := False;
    end;
  end;
end;

procedure CurPageChanged(CurPageID: Integer);
begin
  if CurPageID = PortsPage.ID then
  begin
    // Free up the ports before they get checked: on an upgrade, the currently
    // running JengaDev instance is still holding them, which would otherwise
    // always fail the port-conflict check below on NextButtonClick. This
    // used to be gated on IsUpgrade - a real bug if that ever misdetects
    // (IsUpgrade is just a FileExists check on {app}\JengaDev.exe; anything
    // that makes it wrong, like the user picking a different install
    // directory than the one they're actually running from, meant the old
    // instance never got stopped, and the port check then correctly - but
    // confusingly - reported ports that genuinely were still in use).
    // Unconditional instead: stopping services that aren't running is a
    // harmless no-op, and this is the one place that actually matters for
    // the port check that immediately follows.
    //
    // StopJengaDevServices runs synchronously on the UI thread (it Execs
    // powershell with ewWaitUntilTerminated and can block for several
    // seconds polling for ports to free up) - a click landing on the Next
    // button while that's in flight was getting silently swallowed by the
    // frozen window, so the page looked like it needed two clicks: the
    // first vanished into the freeze, and only the next one actually fired
    // NextButtonClick. Disabling the button for the duration means a click
    // during the freeze does nothing (no lost click, no confusion) instead
    // of nothing visibly happening until a second click finally lands.
    WizardForm.NextButton.Enabled := False;
    WizardForm.BackButton.Enabled := False;
    StopJengaDevServices;
    WizardForm.NextButton.Enabled := True;
    WizardForm.BackButton.Enabled := True;
  end;

  if CurPageID = wpReady then
  begin
    if FileExists(ExpandConstant('{app}\JengaDev.exe')) then
    begin
      WizardForm.ReadyMemo.Lines.Insert(0, 'UPGRADE MODE DETECTED. Existing databases and sites will be preserved.' + #13#10);
      WizardForm.NextButton.Caption := '&Upgrade';
    end;
  end;
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
  PsCmd: String;
begin
  if CurStep = ssPostInstall then
  begin
    PsCmd := '-ExecutionPolicy Bypass -WindowStyle Hidden -Command "';
    
    PsCmd := PsCmd + 'if (!(Test-Path ''' + ExpandConstant('{app}\bin\mysql\bin\mysqld.exe') + ''')) { tar.exe -xf ''' + ExpandConstant('{app}\offline_packages\mariadb.zip') + ''' -C ''' + ExpandConstant('{app}\bin') + '''; Rename-Item -Path ''' + ExpandConstant('{app}\bin\mariadb-12.3.2-winx64') + ''' -NewName ''mysql''; } ' +
             'if (!(Test-Path ''' + ExpandConstant('{app}\bin\phpmyadmin\index.php') + ''')) { tar.exe -xf ''' + ExpandConstant('{app}\offline_packages\phpmyadmin.zip') + ''' -C ''' + ExpandConstant('{app}\bin') + '''; New-Item -ItemType Directory -Force -Path ''' + ExpandConstant('{app}\bin\phpmyadmin') + '''; Copy-Item -Path ''' + ExpandConstant('{app}\bin\phpMyAdmin-5.2.1-all-languages\*') + ''' -Destination ''' + ExpandConstant('{app}\bin\phpmyadmin') + ''' -Recurse -Force; Remove-Item -Path ''' + ExpandConstant('{app}\bin\phpMyAdmin-5.2.1-all-languages') + ''' -Recurse -Force; Copy-Item -Path ''' + ExpandConstant('{app}\scratch\phpmyadmin_config.inc.php') + ''' -Destination ''' + ExpandConstant('{app}\bin\phpmyadmin\config.inc.php') + ''' -Force; } ';
      
    PsCmd := PsCmd + 'if (!(Test-Path ''' + ExpandConstant('{app}\bin\pgsql\bin\postgres.exe') + ''')) { tar.exe -xf ''' + ExpandConstant('{app}\offline_packages\pgsql.zip') + ''' -C ''' + ExpandConstant('{app}\bin') + '''; } ';
      
    PsCmd := PsCmd + 'if (!(Test-Path ''' + ExpandConstant('{app}\bin\mailpit\mailpit.exe') + ''')) { New-Item -ItemType Directory -Force -Path ''' + ExpandConstant('{app}\bin\mailpit') + '''; tar.exe -xf ''' + ExpandConstant('{app}\offline_packages\mailpit.zip') + ''' -C ''' + ExpandConstant('{app}\bin\mailpit') + '''; } ';
      
    // Clean up the offline packages to save space
    PsCmd := PsCmd + 'Remove-Item -Recurse -Force ''' + ExpandConstant('{app}\offline_packages') + '''; ';
      
    // Write dynamic ports configuration
    PsCmd := PsCmd + 'if (!(Test-Path ''' + ExpandConstant('{app}\config') + ''')) { New-Item -ItemType Directory -Force -Path ''' + ExpandConstant('{app}\config') + ''' | Out-Null }; ';
    PsCmd := PsCmd + '$conf = @{ active_php = ''php''; ports = @{ caddy_http = ' + PortsPage.Values[0] + '; caddy_https = ' + PortsPage.Values[1] + '; daemon = ' + PortsPage.Values[2] + '; mysql = ' + PortsPage.Values[3] + '; postgres = ' + PortsPage.Values[4] + '; php = ' + PortsPage.Values[5] + '; mailpit_web = ' + PortsPage.Values[6] + '; mailpit_smtp = ' + PortsPage.Values[7] + ' } }; ';
    PsCmd := PsCmd + 'ConvertTo-Json $conf | Out-File -FilePath ''' + ExpandConstant('{app}\config\jengadev.json') + ''' -Encoding utf8; ';
      
    // Fix Caddyfile absolute paths
    PsCmd := PsCmd + '$appPath = ''' + ExpandConstant('{app}') + '''.Replace(''\'', ''/''); (Get-Content -Path ''' + ExpandConstant('{app}\Caddyfile') + ''') -replace ''C:/safuweb/nexus'', $appPath | Set-Content -Path ''' + ExpandConstant('{app}\Caddyfile') + '''; ';
      
    // Update User PATH environment variable
    PsCmd := PsCmd + '$paths = @(''' + ExpandConstant('{app}\bin\php') + ''', ''' + ExpandConstant('{app}\bin\mysql\bin') + ''', ''' + ExpandConstant('{app}\bin\pgsql\bin') + '''); ' +
             '$userPath = [Environment]::GetEnvironmentVariable(''Path'', [EnvironmentVariableTarget]::User); ' +
             'if ($userPath -eq $null) { $userPath = '''' }; ' +
             '$changed = $false; ' +
             'foreach ($p in $paths) { ' +
             '  if (Test-Path $p) { ' +
             '    if ($userPath -notmatch [regex]::Escape($p)) { ' +
             '      if ($userPath -ne '''' -and $userPath -notmatch '';$'') { $userPath += '';'' }; ' +
             '      $userPath += $p; ' +
             '      $changed = $true; ' +
             '    } ' +
             '  } ' +
             '}; ' +
             'if ($changed) { [Environment]::SetEnvironmentVariable(''Path'', $userPath, [EnvironmentVariableTarget]::User); }; ';
      
    PsCmd := PsCmd + '"';
    
    WizardForm.StatusLabel.Caption := 'Extracting offline databases... (This may take a few minutes)';
    Exec('powershell.exe', PsCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
    
    WizardForm.StatusLabel.Caption := 'Configuring auto-start settings...';
    PsCmd := '-ExecutionPolicy Bypass -WindowStyle Hidden -Command "$services = @(''mysql'', ''postgres'', ''mailpit''); ';
    PsCmd := PsCmd + 'if (!(Test-Path ''' + ExpandConstant('{app}\config\first_run_autostart.json') + ''')) { ConvertTo-Json @($services) | Out-File -FilePath ''' + ExpandConstant('{app}\config\first_run_autostart.json') + ''' -Encoding utf8 } "';
    Exec('powershell.exe', PsCmd, '', SW_HIDE, ewWaitUntilTerminated, ResultCode);
  end;
end;

[UninstallDelete]
Type: filesandordirs; Name: "{app}\bin"
Type: filesandordirs; Name: "{app}\daemon"
Type: filesandordirs; Name: "{app}\dashboard"
Type: filesandordirs; Name: "{app}\node_modules"
Type: filesandordirs; Name: "{app}\scratch"
Type: filesandordirs; Name: "{app}\offline_packages"
Type: files; Name: "{app}\*.exe"
Type: files; Name: "{app}\*.json"
Type: files; Name: "{app}\*.ico"
Type: files; Name: "{app}\Caddyfile"

[Run]
; H6: a fresh top-level C:\ folder (unlike Program Files) inherits C:\'s
; default ACL on this OS, which grants "Authenticated Users" Modify rights -
; i.e. every other account on a shared machine can overwrite JengaDev.exe,
; caddy.exe, mysqld.exe, etc., and the {autostartup} shortcut then runs the
; tampered binary next time the real owner logs in. Re-ACL the tree: only
; SYSTEM/Administrators get Full Control, the installing user gets Modify
; (the app writes its own logs/config/data/www at runtime), everyone else on
; the machine gets Read+Execute only. Runs on every install AND upgrade so
; existing installs get re-secured too. %USERNAME% needs cmd.exe to expand it,
; so this runs through {cmd} rather than calling icacls.exe directly.
Filename: "{cmd}"; Parameters: "/c icacls ""{app}"" /inheritance:r /grant:r ""*S-1-5-18:(OI)(CI)F"" /grant:r ""*S-1-5-32-544:(OI)(CI)F"" /grant:r ""%USERNAME%:(OI)(CI)M"" /grant:r ""*S-1-5-11:(OI)(CI)RX"""; Flags: runhidden; StatusMsg: "Securing install folder permissions..."

; The daemon now requires an auth token on every dashboard API call (see
; C1 in the security audit), so a bare "http://localhost:4000" link would
; just load a broken, 401'd dashboard. JengaDev.exe opens the dashboard
; itself, with a valid token, right after its HTTP listener comes up - so
; launching it here is enough; no separate "open dashboard" Run entry.
; Launched via JengaDevTray.exe (see [Icons] above), which is itself a
; WinForms app with no console to hide, so no launch.vbs/wscript hack is
; needed - its own Process.Start call hides JengaDev.exe's console instead.
Filename: "{app}\JengaDevTray.exe"; Description: "Launch JengaDev"; Flags: nowait postinstall skipifsilent runasoriginaluser; Check: not IsUpgrade
Filename: "{app}\JengaDevTray.exe"; Flags: nowait skipifsilent runasoriginaluser; Check: IsUpgrade
