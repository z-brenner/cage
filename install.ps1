# cage installer for Windows 11. In PowerShell:
#   irm https://github.com/z-brenner/cage/releases/latest/download/install.ps1 | iex
# (or download Install-cage.cmd from the latest release and double-click it)
# It turns on WSL 2 with its own Ubuntu 24.04 (named "cage", separate from any Ubuntu you already have),
# creates your Linux user, installs cage inside it and opens it in your browser. If Windows has to restart
# to turn WSL on, setup carries on by itself after you log back in.
# $env:CAGE_CHECK_ONLY = '1' only checks this PC and prints what it would do.
# $env:CAGE_UNINSTALL = '1' takes cage off this PC instead: its Linux distro (your agents, their logins and files,
# cage's settings), the Start menu shortcut and start at login. Backups in Documents\cage backups stay.
# Kept ASCII-only so Windows PowerShell 5.1 reads it correctly in any code page.

& {
    $ErrorActionPreference = 'Continue'   # native tools (wsl.exe) report through exit codes, checked below
    $Distro = 'cage'
    $Raw = 'https://github.com/z-brenner/cage/releases/latest/download'   # the latest release's installers
    if ($env:CAGE_RAW) { $Raw = $env:CAGE_RAW }
    $tick = [char]0x2713
    $cross = [char]0x2717

    function Say([string]$m) { Write-Host "  $m" }
    function Ok([string]$m) { Write-Host "  $tick " -ForegroundColor Green -NoNewline; Write-Host $m }
    function Stop-Setup([string]$m, [string]$fix) {
        Write-Host "  $cross " -ForegroundColor Red -NoNewline; Write-Host $m
        if ($fix) { Write-Host "    -> $fix" -ForegroundColor DarkGray }
        throw 'cage-stop'
    }
    # On a computer your company manages, some of this is IT's to change: write them a note (Desktop, clipboard).
    function Write-ITNote([string[]]$needs) {
        $lines = @('Hi,', '',
            'I would like to use cage (https://github.com/z-brenner/cage), which runs AI assistants on this',
            'computer, each in a small local virtual machine inside WSL 2. It needs:', '')
        $lines += ($needs | ForEach-Object { "- $_" })
        $lines += @('', 'It does not open any ports to the network. Could you help me set this up?', '', 'Thanks!')
        $text = $lines -join "`r`n"
        if ($env:CAGE_CHECK_ONLY) { Say 'check only: would write this note for your IT department:'; Write-Host $text; return }
        $desk = [Environment]::GetFolderPath('Desktop')
        if (-not $desk) { $desk = $env:USERPROFILE }
        $file = Join-Path $desk 'cage - note for IT.txt'
        try { Set-Content -Path $file -Value $text -Encoding ASCII; Start-Process notepad.exe $file } catch { $file = '' }
        try { Set-Clipboard -Value $text } catch { }
        if ($file) { Say "A note for your IT department is on your Desktop ('cage - note for IT.txt'), and copied." }
        else { Say 'A note for your IT department is copied: paste it into an email.' }
    }
    function Get-Distros {
        # wsl.exe prints UTF-16 unless WSL_UTF8 is set; strip NULs either way.
        $out = & wsl.exe --list --quiet 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return @() }
        return @($out | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
    }
    # Everything this installer and cage put on Windows goes; backups (Documents\cage backups) stay.
    function Remove-Cage {
        $backups = Join-Path $env:USERPROFILE 'Documents\cage backups'
        Say "This takes cage off this PC: its Linux distro '$Distro' with your agents, their logins and files,"
        Say "and cage's settings; the Start menu shortcut; and starting at login."
        Say "Your backups in '$backups' stay."
        if ($env:CAGE_CHECK_ONLY) { Say 'check only: would ask, offer a backup, then remove all of that'; return }
        $env:WSL_UTF8 = '1'
        $answer = Read-Host '  Type remove to take cage off this PC'
        if ($answer -ne 'remove') { Say 'Nothing was removed.'; return }
        if ((Get-Distros) -contains $Distro) {
            $answer = Read-Host '  Make a backup first? [Y/n]'
            if ($answer -notmatch '^[nN]') {
                & wsl.exe -d $Distro -- '~/.local/bin/cage' backup
                if ($LASTEXITCODE -ne 0) { Stop-Setup 'the backup did not work, so nothing was removed' 'run this again, or answer n to go without a backup' }
            }
            & wsl.exe -d $Distro -- '~/.local/bin/cage' uninstall --yes
            & wsl.exe --unregister $Distro
            if ($LASTEXITCODE -ne 0) { Stop-Setup "couldn't remove the Linux distro '$Distro'" "run: wsl --unregister $Distro" }
            Ok "removed the Linux distro '$Distro', and everything in it"
        }
        Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Programs')) 'Cage.lnk')
        Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $env:LOCALAPPDATA 'cage')
        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run' -Name 'cage' -ErrorAction SilentlyContinue
        Remove-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'cage-install' -ErrorAction SilentlyContinue
        Ok 'removed the Start menu shortcut and starting at login'
        Say "Your backups are still in '$backups'."
    }

    try {
        Write-Host ''
        Write-Host '  [' -ForegroundColor Yellow -NoNewline; Write-Host ([char]0x2022) -NoNewline
        Write-Host '|' -ForegroundColor Yellow -NoNewline; Write-Host ([char]0x2022) -NoNewline
        Write-Host ']' -ForegroundColor Yellow -NoNewline; Write-Host ' cage  ' -NoNewline
        if ($env:CAGE_UNINSTALL) { Write-Host 'taking cage off Windows' -ForegroundColor DarkGray }
        else { Write-Host 'setting up on Windows' -ForegroundColor DarkGray }
        Write-Host ''

        if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
            Stop-Setup 'this installer is for Windows' 'on Linux: curl -fsSL https://github.com/z-brenner/cage/releases/latest/download/install.sh | bash'
        }
        if ($env:CAGE_UNINSTALL) { Remove-Cage; return }
        $build = [Environment]::OSVersion.Version.Build
        if ($build -lt 22000) {
            Stop-Setup "cage needs Windows 11 (this PC runs build $build)" 'WSL 2 can only run the agents'' VMs on Windows 11'
        }
        $arch = $env:PROCESSOR_ARCHITECTURE
        if ($env:PROCESSOR_ARCHITEW6432) { $arch = $env:PROCESSOR_ARCHITEW6432 }
        if ($arch -ne 'AMD64') {
            Stop-Setup "cage needs an x64 PC (this one is $arch)" 'Windows on ARM cannot run VMs inside WSL'
        }
        $cs = Get-CimInstance Win32_ComputerSystem
        $cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
        if (-not ($cs.HypervisorPresent -or $cpu.VirtualizationFirmwareEnabled)) {
            Write-ITNote @('hardware virtualization (Intel VT-x or AMD-V) turned on in the firmware settings')
            Stop-Setup 'virtualization is turned off on this PC' 'turn on Intel VT-x or AMD-V (SVM) in your BIOS/UEFI settings, then run this again (on a work PC, IT may need to)'
        }
        Ok 'Windows 11 on an x64 PC with virtualization'

        # A company policy can turn WSL, or the nested virtualization the agents' VMs need, off (Intune: WSL settings).
        $policy = Get-ItemProperty -Path 'HKLM:\SOFTWARE\Policies\WSL' -ErrorAction SilentlyContinue
        $blocked = @()
        if ($policy -and $policy.PSObject.Properties['AllowWSL'] -and $policy.AllowWSL -eq 0) { $blocked += 'WSL 2 allowed (Intune: WSL settings > Allow WSL)' }
        if ($policy -and $policy.PSObject.Properties['AllowNestedVirtualization'] -and $policy.AllowNestedVirtualization -eq 0) {
            $blocked += 'nested virtualization for WSL 2 allowed (Intune: WSL settings > Allow nested virtualization)'
        }
        if ($blocked.Count -gt 0) {
            Write-ITNote $blocked
            Stop-Setup 'your company has turned off part of WSL that cage needs' 'send the note to your IT department, then run this again'
        }

        $free = [math]::Floor((Get-PSDrive -Name ($env:SystemDrive.TrimEnd(':'))).Free / 1GB)
        if ($free -lt 15) { Stop-Setup "only $free GB free on $($env:SystemDrive)" 'cage needs about 15 GB for WSL and your agents: free some space, then run this again' }
        $ram = [math]::Round($cs.TotalPhysicalMemory / 1GB)
        if ($ram -lt 8) { Say "This PC has $ram GB of memory: keep one agent awake at a time." }
        Ok "$free GB free, $ram GB of memory"

        $user = ($env:USERNAME.ToLower() -replace '[^a-z0-9_-]', '')
        if ($user -notmatch '^[a-z_][a-z0-9_-]{0,30}$') { $user = 'cage' }

        if ($env:CAGE_CHECK_ONLY) {
            Say "check only: would set up WSL 2 with an Ubuntu 24.04 named '$Distro' and a Linux user '$user',"
            Say "then run $Raw/install.sh inside it"
            return
        }

        $env:WSL_UTF8 = '1'
        if ((Get-Distros) -notcontains $Distro) {
            # Turning WSL on needs an administrator: on a work PC that's usually IT.
            $admin = (& whoami.exe /groups) -match 'S-1-5-32-544'
            & wsl.exe --status 2>$null | Out-Null
            if ($LASTEXITCODE -ne 0 -and -not $admin) {
                Write-ITNote @('WSL 2 installed (wsl --install), or administrator rights to install it')
                Stop-Setup 'turning on WSL needs an administrator, and your account is not one' 'send the note to your IT department, or ask someone with admin rights to run this'
            }
            Say "Turning on WSL 2 and installing a fresh Ubuntu 24.04 named '$Distro'."
            Say 'Windows may ask for permission; this takes a few minutes.'
            & wsl.exe --update 2>$null | Out-Null   # the newest WSL knows --name; harmless if WSL isn't on yet
            & wsl.exe --install --distribution Ubuntu-24.04 --name $Distro --no-launch --web-download
            if ((Get-Distros) -notcontains $Distro) {
                # WSL itself was just turned on: Windows needs a restart before it can install Ubuntu.
                $again = "powershell.exe -NoProfile -ExecutionPolicy Bypass -Command `"irm $Raw/install.ps1 | iex`""
                Set-ItemProperty -Path 'HKCU:\Software\Microsoft\Windows\CurrentVersion\RunOnce' -Name 'cage-install' -Value $again
                Write-Host ''
                Say 'Windows needs to restart once to finish turning on WSL.'
                Say 'Setup carries on by itself after you log back in.'
                $answer = Read-Host '  Restart now? [Y/n]'
                if ($answer -notmatch '^[nN]') { Restart-Computer -Force }
                return
            }
        }
        Ok "WSL 2 with its own Ubuntu ('$Distro')"

        # Your Linux user: no password prompt, sudo without a password (it's your own dedicated distro),
        # in the kvm group for the agents' VMs. Opening "cage" from the Start menu shows your agents.
        $rootSetup = @"
set -e
getent group kvm >/dev/null || groupadd -r kvm
id -u $user >/dev/null 2>&1 || useradd -m -s /bin/bash -G sudo,kvm $user
usermod -aG kvm $user
echo '$user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/90-cage
chmod 440 /etc/sudoers.d/90-cage
grep -q '^\[user\]' /etc/wsl.conf 2>/dev/null || printf '\n[user]\ndefault=$user\n' >> /etc/wsl.conf
(apt-get update -qq && apt-get install -y -qq qrencode) >/dev/null 2>&1 || true
grep -q 'cage: show your agents' /home/$user/.bashrc 2>/dev/null || cat >> /home/$user/.bashrc <<'CAGERC'
"@
        $rootSetup += @'

# cage: show your agents whenever you open this terminal (set CAGE_NO_HOME=1 to skip)
if [ -t 1 ] && [ -z "${CAGE_NO_HOME:-}" ] && [ -x "$HOME/.local/bin/cage" ]; then "$HOME/.local/bin/cage"; fi
CAGERC

'@
        $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($rootSetup.Replace("`r", '')))
        & wsl.exe -d $Distro -u root -- bash -c "echo $b64 | base64 -d | bash"
        if ($LASTEXITCODE -ne 0) { Stop-Setup "couldn't create your Linux user in '$Distro'" "run this again; if it keeps failing: wsl --unregister $Distro, then run this again" }
        & wsl.exe --terminate $Distro | Out-Null
        Ok "your Linux user '$user'"

        # "Cage" in the Start menu opens the web app: a hidden launcher (no console window) runs `cage ui` in WSL.
        $appDir = Join-Path $env:LOCALAPPDATA 'cage'
        New-Item -ItemType Directory -Force -Path $appDir | Out-Null
        $vbs = Join-Path $appDir 'cage.vbs'
        $run = "wsl.exe -d $Distro -u $user --exec /home/$user/.local/bin/cage ui"
        Set-Content -Path $vbs -Encoding ASCII -Value ('CreateObject("WScript.Shell").Run "' + $run + '", 0, False')

        Say 'Installing cage; the setup continues in your browser.'
        Write-Host ''
        # Downloaded to a file first, so a failed download is an error here instead of an empty script that "works".
        $get = @'
set -o pipefail
f="$(mktemp)"
curl -fsSL --retry 3 -o "$f" "@RAW@/install.sh" && bash "$f"
rc=$?
rm -f "$f"
exit $rc
'@
        $get64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($get.Replace('@RAW@', $Raw).Replace("`r", '')))
        & wsl.exe -d $Distro -u $user --cd '~' -- bash -lc "bash <(echo $get64 | base64 -d)"
        if ($LASTEXITCODE -ne 0) { Stop-Setup "cage couldn't be installed inside WSL" 'check your internet connection, then run this again' }
        Write-Host ''
        try {
            Copy-Item -Force "\\wsl.localhost\$Distro\home\$user\cage\assets\cage.ico" (Join-Path $appDir 'cage.ico') -ErrorAction Stop
        } catch {
            try { Copy-Item -Force ('\\wsl$\' + $Distro + '\home\' + $user + '\cage\assets\cage.ico') (Join-Path $appDir 'cage.ico') -ErrorAction Stop } catch { }
        }
        $lnk = Join-Path ([Environment]::GetFolderPath('Programs')) 'Cage.lnk'
        $shortcut = (New-Object -ComObject WScript.Shell).CreateShortcut($lnk)
        $shortcut.TargetPath = Join-Path $env:WINDIR 'System32\wscript.exe'
        $shortcut.Arguments = '"' + $vbs + '"'
        $shortcut.Description = 'Your AI agents, each in its own little cage'
        if (Test-Path (Join-Path $appDir 'cage.ico')) { $shortcut.IconLocation = (Join-Path $appDir 'cage.ico') }
        $shortcut.Save()
        Ok "'Cage' in your Start menu opens your agents"
    }
    catch {
        if ("$_" -ne 'cage-stop') { Write-Host "  $cross $_" -ForegroundColor Red }
    }
}
