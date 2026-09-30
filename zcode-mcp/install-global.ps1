[CmdletBinding(SupportsShouldProcess = $true, ConfirmImpact = 'Medium')]
param(
    [string]$CodexHome,
    [string]$NodePath,
    [string]$CodexCliPath,
    [string]$ZCodeCliPath,
    [switch]$Install
)

Set-StrictMode -Version Latest

$script:ServerName = 'zcode_bridge'
$script:RuntimeFileNames = @('mcp-server.mjs', 'app-server-client.mjs', 'communication-journal.mjs')

function Get-ApplicationPath {
    param([Parameter(Mandatory = $true)][string]$Name)

    $application = Get-Command -Name $Name -CommandType Application -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -ne $application -and -not [string]::IsNullOrWhiteSpace($application.Source)) {
        return $application.Source
    }
    return $null
}

function Resolve-ExecutablePath {
    param(
        [Parameter(Mandatory = $true)][string]$Label,
        [string]$RequestedPath,
        [Parameter(Mandatory = $true)][string]$CommandName,
        [string[]]$FallbackPaths = @()
    )

    $candidate = $RequestedPath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        $candidate = Get-ApplicationPath -Name $CommandName
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        foreach ($fallback in $FallbackPaths) {
            if (-not [string]::IsNullOrWhiteSpace($fallback) -and
                (Test-Path -LiteralPath $fallback -PathType Leaf)) {
                $candidate = $fallback
                break
            }
        }
    }
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        throw "$Label was not found. Pass its path explicitly."
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($candidate)
    }
    catch {
        throw "$Label path is invalid."
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "$Label was not found. Pass its path explicitly."
    }
    return $fullPath
}

function Resolve-CodexCliPath {
    param([string]$RequestedPath)

    if (-not [string]::IsNullOrWhiteSpace($RequestedPath)) {
        return Resolve-ExecutablePath -Label 'Codex CLI' -RequestedPath $RequestedPath -CommandName 'codex.exe'
    }

    $fromPath = Get-ApplicationPath -Name 'codex.exe'
    if ([string]::IsNullOrWhiteSpace($fromPath)) {
        $fromPath = Get-ApplicationPath -Name 'codex'
    }
    if (-not [string]::IsNullOrWhiteSpace($fromPath)) {
        return Resolve-ExecutablePath -Label 'Codex CLI' -RequestedPath $fromPath -CommandName 'codex.exe'
    }

    $roots = @()
    if (-not [string]::IsNullOrWhiteSpace($env:LOCALAPPDATA)) {
        $roots += (Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin')
        $roots += (Join-Path $env:LOCALAPPDATA 'Programs\OpenAI\Codex\bin')
    }
    $candidates = @()
    foreach ($root in $roots) {
        if (-not (Test-Path -LiteralPath $root -PathType Container)) {
            continue
        }
        foreach ($versionDirectory in (Get-ChildItem -LiteralPath $root -Directory -ErrorAction SilentlyContinue)) {
            $candidate = Join-Path $versionDirectory.FullName 'codex.exe'
            if (Test-Path -LiteralPath $candidate -PathType Leaf) {
                $candidates += Get-Item -LiteralPath $candidate
            }
        }
    }
    $selected = $candidates | Sort-Object -Property LastWriteTime -Descending | Select-Object -First 1
    if ($null -eq $selected) {
        throw 'Codex CLI was not found. Pass its path with -CodexCliPath.'
    }
    return Resolve-ExecutablePath -Label 'Codex CLI' -RequestedPath $selected.FullName -CommandName 'codex.exe'
}

function Resolve-CodexHomePath {
    param([string]$RequestedPath)

    $candidate = $RequestedPath
    if ([string]::IsNullOrWhiteSpace($candidate)) {
        if (-not [string]::IsNullOrWhiteSpace($env:CODEX_HOME)) {
            $candidate = $env:CODEX_HOME
        }
        elseif (-not [string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
            $candidate = Join-Path $env:USERPROFILE '.codex'
        }
        else {
            throw 'Codex home could not be determined. Pass its path with -CodexHome.'
        }
    }

    try {
        $fullPath = [System.IO.Path]::GetFullPath($candidate)
    }
    catch {
        throw 'Codex home path is invalid.'
    }
    if (-not (Test-Path -LiteralPath $fullPath -PathType Container)) {
        throw 'Codex home directory does not exist. No files or settings were changed.'
    }
    return $fullPath
}

function Resolve-ZCodeCliPath {
    param([string]$RequestedPath)

    if ([string]::IsNullOrWhiteSpace($RequestedPath)) {
        throw 'ZCode CLI path is required. Pass it with -ZCodeCliPath.'
    }
    try {
        $fullPath = [System.IO.Path]::GetFullPath($RequestedPath)
    }
    catch {
        throw 'ZCode CLI path is invalid.'
    }
    if ([System.IO.Path]::GetExtension($fullPath) -ine '.cjs' -or
        -not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw 'ZCode CLI file was not found. Pass the path to your installed zcode.cjs.'
    }
    return $fullPath
}
function Get-ObjectProperty {
    param(
        [Parameter(Mandatory = $true)][object]$InputObject,
        [Parameter(Mandatory = $true)][string]$Name
    )

    if ($InputObject -is [System.Collections.IDictionary]) {
        if ($InputObject.Contains($Name)) {
            return [pscustomobject]@{ Exists = $true; Value = $InputObject[$Name] }
        }
    }
    else {
        $property = $InputObject.PSObject.Properties[$Name]
        if ($null -ne $property) {
            return [pscustomobject]@{ Exists = $true; Value = $property.Value }
        }
    }
    return [pscustomobject]@{ Exists = $false; Value = $null }
}

function Add-UniqueObject {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$List,
        [Parameter(Mandatory = $true)][object]$Value
    )

    foreach ($existing in $List) {
        if ([object]::ReferenceEquals($existing, $Value)) {
            return
        }
    }
    [void]$List.Add($Value)
}

function Visit-JsonTree {
    param(
        [object]$Value,
        [Parameter(Mandatory = $true)][string]$ExpectedName,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$NameMatches,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[object]]$CommandMatches
    )

    if ($null -eq $Value -or $Value -is [string]) {
        return
    }

    if ($Value -is [System.Collections.IDictionary]) {
        $nameProperty = Get-ObjectProperty -InputObject $Value -Name 'name'
        if ($nameProperty.Exists -and
            [string]$nameProperty.Value -ceq $ExpectedName) {
            Add-UniqueObject -List $NameMatches -Value $Value
        }
        if ($Value.Contains($ExpectedName)) {
            Add-UniqueObject -List $NameMatches -Value $Value[$ExpectedName]
        }
        if ($Value.Contains('command')) {
            Add-UniqueObject -List $CommandMatches -Value $Value
        }
        foreach ($child in $Value.Values) {
            Visit-JsonTree -Value $child -ExpectedName $ExpectedName -NameMatches $NameMatches -CommandMatches $CommandMatches
        }
        return
    }

    if ($Value -is [System.Collections.IEnumerable]) {
        foreach ($child in $Value) {
            Visit-JsonTree -Value $child -ExpectedName $ExpectedName -NameMatches $NameMatches -CommandMatches $CommandMatches
        }
        return
    }

    $nameProperty = Get-ObjectProperty -InputObject $Value -Name 'name'
    if ($nameProperty.Exists -and
        [string]$nameProperty.Value -ceq $ExpectedName) {
        Add-UniqueObject -List $NameMatches -Value $Value
    }
    $namedProperty = Get-ObjectProperty -InputObject $Value -Name $ExpectedName
    if ($namedProperty.Exists) {
        Add-UniqueObject -List $NameMatches -Value $namedProperty.Value
    }
    $commandProperty = Get-ObjectProperty -InputObject $Value -Name 'command'
    if ($commandProperty.Exists) {
        Add-UniqueObject -List $CommandMatches -Value $Value
    }
    foreach ($property in $Value.PSObject.Properties) {
        Visit-JsonTree -Value $property.Value -ExpectedName $ExpectedName -NameMatches $NameMatches -CommandMatches $CommandMatches
    }
}

function ConvertFrom-PrivateJson {
    param(
        [Parameter(Mandatory = $true)][string]$Text,
        [Parameter(Mandatory = $true)][string]$Purpose
    )

    try {
        return ConvertFrom-Json -InputObject $Text -ErrorAction Stop
    }
    catch {
        throw "Codex CLI returned unreadable MCP data while checking $Purpose. No changes were made."
    }
}

function Invoke-CodexCli {
    param([Parameter(Mandatory = $true)][string[]]$CliArguments)

    $hadCodexHome = Test-Path -LiteralPath 'Env:CODEX_HOME'
    $previousCodexHome = $env:CODEX_HOME
    try {
        $env:CODEX_HOME = $script:ResolvedCodexHome
        $outputLines = @(& $script:ResolvedCodexCliPath @CliArguments 2>$null)
        $exitCode = $LASTEXITCODE
        $outputText = [string]::Join([Environment]::NewLine, [string[]]$outputLines)
    }
    catch {
        throw 'Codex CLI could not be started. No configuration was changed.'
    }
    finally {
        if ($hadCodexHome) {
            $env:CODEX_HOME = $previousCodexHome
        }
        else {
            Remove-Item -LiteralPath 'Env:CODEX_HOME' -ErrorAction SilentlyContinue
        }
    }
    return [pscustomobject]@{ ExitCode = $exitCode; Output = $outputText }
}

function Test-RegistrationEnabled {
    param([Parameter(Mandatory = $true)][object]$Entry)

    $enabled = Get-ObjectProperty -InputObject $Entry -Name 'enabled'
    if ($enabled.Exists -and $enabled.Value -is [bool] -and -not $enabled.Value) {
        return $false
    }
    $disabled = Get-ObjectProperty -InputObject $Entry -Name 'disabled'
    if ($disabled.Exists -and $disabled.Value -is [bool] -and $disabled.Value) {
        return $false
    }
    return $true
}

function Test-RegistrationCompatibility {
    param(
        [Parameter(Mandatory = $true)][object]$Entry,
        [Parameter(Mandatory = $true)][string]$ExpectedNodePath,
        [Parameter(Mandatory = $true)][string]$ExpectedServerPath,
        [Parameter(Mandatory = $true)][string]$ExpectedZCodeCliPath
    )

    $name = Get-ObjectProperty -InputObject $Entry -Name 'name'
    if ($name.Exists -and [string]$name.Value -cne $script:ServerName) {
        return $false
    }
    if (-not (Test-RegistrationEnabled -Entry $Entry)) {
        return $false
    }

    $command = Get-ObjectProperty -InputObject $Entry -Name 'command'
    $arguments = Get-ObjectProperty -InputObject $Entry -Name 'args'
    if (-not $command.Exists -or -not $arguments.Exists -or
        -not ($command.Value -is [string]) -or
        -not [string]::Equals([string]$command.Value, $ExpectedNodePath, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    if ($arguments.Value -is [string] -or $null -eq $arguments.Value) {
        return $false
    }
    $argumentItems = @($arguments.Value)
    if ($argumentItems.Count -ne 1 -or
        -not ($argumentItems[0] -is [string]) -or
        -not [string]::Equals([string]$argumentItems[0], $ExpectedServerPath, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }

    $environment = Get-ObjectProperty -InputObject $Entry -Name 'env'
    if (-not $environment.Exists -or $null -eq $environment.Value) {
        return $false
    }
    $configuredZCodeCli = Get-ObjectProperty -InputObject $environment.Value -Name 'ZCODE_CLI'
    if (-not $configuredZCodeCli.Exists -or
        -not ($configuredZCodeCli.Value -is [string]) -or
        -not [string]::Equals([string]$configuredZCodeCli.Value, $ExpectedZCodeCliPath, [StringComparison]::OrdinalIgnoreCase)) {
        return $false
    }
    return $true
}

function Get-McpRegistration {
    param(
        [Parameter(Mandatory = $true)][string]$ExpectedNodePath,
        [Parameter(Mandatory = $true)][string]$ExpectedServerPath,
        [Parameter(Mandatory = $true)][string]$ExpectedZCodeCliPath
    )

    $listResult = Invoke-CodexCli -CliArguments @('mcp', 'list', '--json')
    if ($listResult.ExitCode -ne 0) {
        throw 'Codex CLI could not inspect MCP registrations. No changes were made.'
    }
    $listJson = ConvertFrom-PrivateJson -Text $listResult.Output -Purpose 'the registration list'
    $listNames = [System.Collections.Generic.List[object]]::new()
    $listCommands = [System.Collections.Generic.List[object]]::new()
    Visit-JsonTree -Value $listJson -ExpectedName $script:ServerName -NameMatches $listNames -CommandMatches $listCommands
    if ($listNames.Count -eq 0) {
        return [pscustomobject]@{ State = 'absent' }
    }
    if ($listNames.Count -ne 1) {
        throw "The existing '$($script:ServerName)' registration is ambiguous. No changes were made."
    }

    $getResult = Invoke-CodexCli -CliArguments @('mcp', 'get', '--json', $script:ServerName)
    if ($getResult.ExitCode -ne 0) {
        throw "The existing '$($script:ServerName)' registration could not be inspected. No changes were made."
    }
    $entryJson = ConvertFrom-PrivateJson -Text $getResult.Output -Purpose 'the existing registration'
    $entryNames = [System.Collections.Generic.List[object]]::new()
    $entryCommands = [System.Collections.Generic.List[object]]::new()
    Visit-JsonTree -Value $entryJson -ExpectedName $script:ServerName -NameMatches $entryNames -CommandMatches $entryCommands

    $entry = $null
    if ($entryNames.Count -eq 1) {
        $entry = $entryNames[0]
        if (-not (Test-RegistrationEnabled -Entry $entry)) {
            throw "The existing '$($script:ServerName)' registration is incompatible. Review it manually; no settings were changed."
        }
        $entryCommand = Get-ObjectProperty -InputObject $entry -Name 'command'
        if (-not $entryCommand.Exists -and $entryCommands.Count -eq 1) {
            $entry = $entryCommands[0]
        }
    }
    elseif ($entryNames.Count -gt 1) {
        throw "The existing '$($script:ServerName)' registration is ambiguous. No changes were made."
    }
    elseif ($entryCommands.Count -eq 1) {
        $entry = $entryCommands[0]
    }
    else {
        throw "The existing '$($script:ServerName)' registration could not be inspected. No changes were made."
    }

    if (Test-RegistrationCompatibility -Entry $entry -ExpectedNodePath $ExpectedNodePath -ExpectedServerPath $ExpectedServerPath -ExpectedZCodeCliPath $ExpectedZCodeCliPath) {
        return [pscustomobject]@{ State = 'compatible' }
    }
    throw "The existing '$($script:ServerName)' registration is incompatible. Review it manually; no settings were changed."
}

function Test-IsReparsePoint {
    param([Parameter(Mandatory = $true)][string]$LiteralPath)

    if (-not (Test-Path -LiteralPath $LiteralPath)) {
        return $false
    }
    $item = Get-Item -LiteralPath $LiteralPath -Force
    return (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-InstallState {
    param([Parameter(Mandatory = $true)][hashtable]$ExpectedHashes)

    if (-not (Test-Path -LiteralPath $script:InstallDirectory -PathType Container)) {
        return [pscustomobject]@{ State = 'fresh' }
    }
    if (Test-IsReparsePoint -LiteralPath $script:InstallDirectory) {
        throw 'The stable install directory is a link or junction. No files were changed.'
    }

    $children = @(Get-ChildItem -LiteralPath $script:InstallDirectory -Force -ErrorAction Stop)
    if ($children.Count -eq 0) {
        return [pscustomobject]@{ State = 'fresh' }
    }
    if ($children.Count -ne $script:RuntimeFileNames.Count) {
        throw 'The stable install directory contains unexpected files. Review it manually; no files were changed.'
    }

    foreach ($fileName in $script:RuntimeFileNames) {
        $child = $children | Where-Object { $_.Name -ceq $fileName } | Select-Object -First 1
        if ($null -eq $child -or $child.PSIsContainer -or
            (Test-IsReparsePoint -LiteralPath $child.FullName)) {
            throw 'The stable runtime copy is incomplete or unexpected. Review it manually; no files were changed.'
        }
        $actualHash = (Get-FileHash -LiteralPath $child.FullName -Algorithm SHA256).Hash
        if (-not [string]::Equals($actualHash, $ExpectedHashes[$fileName], [StringComparison]::OrdinalIgnoreCase)) {
            throw 'The stable runtime copy differs from the source files. Review it manually; no files were changed.'
        }
    }
    return [pscustomobject]@{ State = 'consistent' }
}

function Get-BridgeVersion {
    param([Parameter(Mandatory = $true)][string]$ServerFilePath)

    $serverText = [System.IO.File]::ReadAllText($ServerFilePath)
    $versionMatch = [regex]::Match($serverText, '(?m)^\s*const\s+SERVER_VERSION\s*=\s*"(?<version>[^"]+)"\s*;')
    if (-not $versionMatch.Success) {
        throw 'The bridge entry point has no readable version marker.'
    }
    return $versionMatch.Groups['version'].Value
}

function Assert-SourceRuntime {
    param(
        [Parameter(Mandatory = $true)][string]$NodeExecutable,
        [Parameter(Mandatory = $true)][string]$ServerFilePath,
        [Parameter(Mandatory = $true)][string]$ClientFilePath,
        [Parameter(Mandatory = $true)][string]$JournalFilePath
    )

    foreach ($filePath in @($ServerFilePath, $ClientFilePath, $JournalFilePath)) {
        if (-not (Test-Path -LiteralPath $filePath -PathType Leaf)) {
            throw 'A required ZCode bridge runtime file is missing from the source directory.'
        }
        & $NodeExecutable --check $filePath 2>$null | Out-Null
        if ($LASTEXITCODE -ne 0) {
            throw 'A ZCode bridge runtime file failed the Node.js syntax check.'
        }
    }

    $serverText = [System.IO.File]::ReadAllText($ServerFilePath)
    $clientText = [System.IO.File]::ReadAllText($ClientFilePath)
    $journalText = [System.IO.File]::ReadAllText($JournalFilePath)
    $serverImports = [regex]::Matches($serverText, '\bfrom\s+["''](?<path>[^"'']+)["'']') |
        ForEach-Object { $_.Groups['path'].Value } |
        Where-Object { $_.StartsWith('./') -or $_.StartsWith('../') }
    $actualServerImports = @($serverImports | Sort-Object)
    $expectedServerImports = @('./app-server-client.mjs', './communication-journal.mjs')
    $expectedServerImports = @($expectedServerImports | Sort-Object)
    $serverImportDifferences = @(Compare-Object -ReferenceObject $expectedServerImports -DifferenceObject $actualServerImports -CaseSensitive)
    if ($actualServerImports.Count -ne $expectedServerImports.Count -or $serverImportDifferences.Count -ne 0) {
        throw 'The bridge entry point has an unexpected local runtime dependency.'
    }
    $clientImports = [regex]::Matches($clientText, '\bfrom\s+["''](?<path>[^"'']+)["'']') |
        ForEach-Object { $_.Groups['path'].Value } |
        Where-Object { $_.StartsWith('./') -or $_.StartsWith('../') }
    if (@($clientImports).Count -ne 0) {
        throw 'The bridge app-server client has an unexpected local runtime dependency.'
    }
    $journalImports = [regex]::Matches($journalText, '\bfrom\s+["''](?<path>[^"'']+)["'']') |
        ForEach-Object { $_.Groups['path'].Value } |
        Where-Object { $_.StartsWith('./') -or $_.StartsWith('../') }
    if (@($journalImports).Count -ne 0) {
        throw 'The bridge communication journal has an unexpected local runtime dependency.'
    }

    return Get-BridgeVersion -ServerFilePath $ServerFilePath
}

function Copy-RuntimeFiles {
    param([Parameter(Mandatory = $true)][hashtable]$ExpectedHashes)

    $state = Get-InstallState -ExpectedHashes $ExpectedHashes
    if ($state.State -eq 'consistent') {
        return
    }
    if (-not (Test-Path -LiteralPath $script:InstallDirectory -PathType Container)) {
        [void][System.IO.Directory]::CreateDirectory($script:InstallDirectory)
    }
    $state = Get-InstallState -ExpectedHashes $ExpectedHashes
    if ($state.State -ne 'fresh') {
        throw 'The stable install directory changed during preflight. No files were copied.'
    }

    foreach ($fileName in $script:RuntimeFileNames) {
        $sourcePath = Join-Path $script:SourceDirectory $fileName
        $targetPath = Join-Path $script:InstallDirectory $fileName
        Copy-Item -LiteralPath $sourcePath -Destination $targetPath -ErrorAction Stop
    }
    $verifiedState = Get-InstallState -ExpectedHashes $ExpectedHashes
    if ($verifiedState.State -ne 'consistent') {
        throw 'The stable runtime copy did not match the source files.'
    }
}

try {
    $script:ResolvedCodexHome = Resolve-CodexHomePath -RequestedPath $CodexHome
    $script:ResolvedNodePath = Resolve-ExecutablePath -Label 'Node.js' -RequestedPath $NodePath -CommandName 'node.exe' -FallbackPaths @((Join-Path $env:ProgramFiles 'nodejs\node.exe'))
    $script:ResolvedCodexCliPath = Resolve-CodexCliPath -RequestedPath $CodexCliPath
    $script:ResolvedZCodeCliPath = Resolve-ZCodeCliPath -RequestedPath $ZCodeCliPath

    $script:SourceDirectory = [System.IO.Path]::GetFullPath($PSScriptRoot)
    $script:SourceServerPath = Join-Path $script:SourceDirectory 'mcp-server.mjs'
    $script:SourceClientPath = Join-Path $script:SourceDirectory 'app-server-client.mjs'
    $script:SourceJournalPath = Join-Path $script:SourceDirectory 'communication-journal.mjs'
    $script:InstallDirectory = [System.IO.Path]::GetFullPath((Join-Path $script:ResolvedCodexHome 'tools\zcode-bridge'))
    $toolsDirectory = Join-Path $script:ResolvedCodexHome 'tools'

    if (Test-IsReparsePoint -LiteralPath $toolsDirectory) {
        throw 'The Codex tools directory is a link or junction. No files were changed.'
    }
    if (Test-IsReparsePoint -LiteralPath $script:InstallDirectory) {
        throw 'The stable install directory is a link or junction. No files were changed.'
    }

    $sourceVersion = Assert-SourceRuntime -NodeExecutable $script:ResolvedNodePath -ServerFilePath $script:SourceServerPath -ClientFilePath $script:SourceClientPath -JournalFilePath $script:SourceJournalPath
    $sourceHashes = @{}
    foreach ($fileName in $script:RuntimeFileNames) {
        $sourcePath = Join-Path $script:SourceDirectory $fileName
        $sourceHashes[$fileName] = (Get-FileHash -LiteralPath $sourcePath -Algorithm SHA256).Hash
    }

    $copyState = Get-InstallState -ExpectedHashes $sourceHashes
    $registration = Get-McpRegistration -ExpectedNodePath $script:ResolvedNodePath -ExpectedServerPath (Join-Path $script:InstallDirectory 'mcp-server.mjs') -ExpectedZCodeCliPath $script:ResolvedZCodeCliPath

    if (-not $Install) {
        if ($copyState.State -eq 'consistent' -and $registration.State -eq 'compatible') {
            Write-Host "Preflight passed for $($script:ServerName) v$sourceVersion. Runtime files and registration are already consistent; no changes were made."
        }
        else {
            Write-Host "Preflight passed for $($script:ServerName) v$sourceVersion. Run with -Install to copy the three runtime files and add the MCP entry; no changes were made."
        }
        return
    }

    if ($copyState.State -ne 'consistent') {
        if (-not $PSCmdlet.ShouldProcess($script:InstallDirectory, 'Copy the three ZCode bridge runtime files')) {
            return
        }
        Copy-RuntimeFiles -ExpectedHashes $sourceHashes
    }

    if ($registration.State -eq 'absent') {
        if (-not $PSCmdlet.ShouldProcess("Codex MCP entry $($script:ServerName)", 'Register the local stdio bridge')) {
            return
        }
        $latestRegistration = Get-McpRegistration -ExpectedNodePath $script:ResolvedNodePath -ExpectedServerPath (Join-Path $script:InstallDirectory 'mcp-server.mjs') -ExpectedZCodeCliPath $script:ResolvedZCodeCliPath
        if ($latestRegistration.State -eq 'incompatible') {
            throw "The existing '$($script:ServerName)' registration is incompatible. Review it manually; no settings were changed."
        }
        if ($latestRegistration.State -eq 'absent') {
            $addResult = Invoke-CodexCli -CliArguments @('mcp', 'add', $script:ServerName, '--env', "ZCODE_CLI=$($script:ResolvedZCodeCliPath)", '--', $script:ResolvedNodePath, (Join-Path $script:InstallDirectory 'mcp-server.mjs'))
            if ($addResult.ExitCode -ne 0) {
                throw 'Codex CLI could not add the MCP entry. Runtime files were left in place; no existing configuration was removed.'
            }
        }
    }

    $finalRegistration = Get-McpRegistration -ExpectedNodePath $script:ResolvedNodePath -ExpectedServerPath (Join-Path $script:InstallDirectory 'mcp-server.mjs') -ExpectedZCodeCliPath $script:ResolvedZCodeCliPath
    if ($finalRegistration.State -ne 'compatible') {
        throw "The '$($script:ServerName)' registration did not match the expected launch command. Review it manually."
    }
    Write-Host "Installed $($script:ServerName) v$sourceVersion. The runtime copy matches the source files."
}
catch {
    Write-Error -Message $_.Exception.Message
    exit 1
}
