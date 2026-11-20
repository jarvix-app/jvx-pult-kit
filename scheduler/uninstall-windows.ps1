<#
.SYNOPSIS
    Снимает расписание адъютанта из Планировщика заданий Windows.

.PARAMETER Prefix       Префикс имён заданий (как при установке).
.PARAMETER RemoveState  Удалить ещё и состояние сторожа: курсор, журнал, замок (%LOCALAPPDATA%\pult-kit\watchdog).
                        Без этого курсор остаётся и сторож после повторной установки продолжит с того же места.

    Проверить, ничего не меняя:  powershell -File uninstall-windows.ps1 -WhatIf
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$Prefix = 'JvxPult',
    [switch]$RemoveState
)

$ErrorActionPreference = 'Stop'

foreach ($name in "$Prefix-utro", "$Prefix-den", "$Prefix-vecher", "$Prefix-watchdog", "$Prefix-voice") {
    $task = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
    if (-not $task) {
        Write-Host "Нет задания: $name"
        continue
    }
    if ($PSCmdlet.ShouldProcess($name, 'Удалить задание из Планировщика')) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "Удалено: $name"
    }
}

if ($RemoveState) {
    $state = Join-Path $env:LOCALAPPDATA 'pult-kit\watchdog'
    if ((Test-Path -LiteralPath $state) -and $PSCmdlet.ShouldProcess($state, 'Удалить состояние сторожа')) {
        Remove-Item -LiteralPath $state -Recurse -Force
        Write-Host "Удалено: $state"
    }
}
