# cage installer for Windows 11. In PowerShell:
#   irm https://raw.githubusercontent.com/z-brenner/cage/main/install.ps1 | iex
# It turns on WSL 2 with its own Ubuntu 24.04 (named "cage", separate from any Ubuntu you already have),
# creates your Linux user, installs cage inside it and starts the guided setup. If Windows has to restart
# to turn WSL on, setup carries on by itself after you log back in.
# $env:CAGE_CHECK_ONLY = '1' only checks this PC and prints what it would do.
# Kept ASCII-only so Windows PowerShell 5.1 reads it correctly in any code page.

& {
    $ErrorActionPreference = 'Continue'   # native tools (wsl.exe) report through exit codes, checked below
    $Distro = 'cage'
    $Raw = 'https://raw.githubusercontent.com/z-brenner/cage/main'
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
    function Get-Distros {
        # wsl.exe prints UTF-16 unless WSL_UTF8 is set; strip NULs either way.
        $out = & wsl.exe --list --quiet 2>$null
        if ($LASTEXITCODE -ne 0 -or -not $out) { return @() }
        return @($out | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ })
    }

    try {
        Write-Host ''
        Write-Host '  [' -ForegroundColor Yellow -NoNewline; Write-Host ([char]0x2022) -NoNewline
        Write-Host '|' -ForegroundColor Yellow -NoNewline; Write-Host ([char]0x2022) -NoNewline
        Write-Host ']' -ForegroundColor Yellow -NoNewline; Write-Host ' cage  ' -NoNewline
        Write-Host 'setting up on Windows' -ForegroundColor DarkGray
        Write-Host ''

        if ([Environment]::OSVersion.Platform -ne 'Win32NT') {
            Stop-Setup 'this installer is for Windows' 'on Linux: curl -fsSL https://raw.githubusercontent.com/z-brenner/cage/main/install.sh | bash'
        }
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
            Stop-Setup 'virtualization is turned off on this PC' 'turn on Intel VT-x or AMD-V (SVM) in your BIOS/UEFI settings, then run this again'
        }
        Ok 'Windows 11 on an x64 PC with virtualization'

        $user = ($env:USERNAME.ToLower() -replace '[^a-z0-9_-]', '')
        if ($user -notmatch '^[a-z_][a-z0-9_-]{0,30}$') { $user = 'cage' }

        if ($env:CAGE_CHECK_ONLY) {
            Say "check only: would set up WSL 2 with an Ubuntu 24.04 named '$Distro' and a Linux user '$user',"
            Say "then run $Raw/install.sh inside it"
            return
        }

        $env:WSL_UTF8 = '1'
        if ((Get-Distros) -notcontains $Distro) {
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

        Say 'Installing cage and starting the guided setup...'
        Write-Host ''
        & wsl.exe -d $Distro -u $user --cd '~' -- bash -lc "curl -fsSL $Raw/install.sh | bash"
        Write-Host ''
        Say "Next time, open 'cage' from the Start menu to see your agents."
    }
    catch {
        if ("$_" -ne 'cage-stop') { Write-Host "  $cross $_" -ForegroundColor Red }
    }
}
