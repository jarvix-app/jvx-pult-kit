<#
.SYNOPSIS
    Ставит расписание адъютанта в Планировщик заданий Windows на компьютере продакта.

.DESCRIPTION
    Задания (все под префиксом JvxPult, запуск из каталога набора):
      JvxPult-watchdog  каждые N минут     -> сторож без LLM: читает ленту событий, будит "/razbor" не чаще заданного
                                              промежутка и сам запускает "/utro", "/den", "/vecher" в часы команды, а слои
                                              пульса "/nedelya" и "/mesyac" - в день и час из настроек, после вечернего запуска
      JvxPult-voice     каждые 5 минут     -> расшифровка голоса локальной моделью; модель грузится, только если есть работа

    Ритм адъютанта - настройки команды, их меняет продакт на экране сервера: часы /utro, /den, /vecher (по поясу
    команды), день и часы недельного и месячного слоёв пульса (/nedelya, /mesyac), интервал сторожа N, минимальный
    промежуток побудки. Ритуалы циклов /cikl и /sprint отдельного расписания не имеют: что пора по циклам, утренний
    запуск спрашивает у сервера (pult cycle due). Часы и промежуток сторож читает сам
    (pult settings) и в Планировщике их нет, поэтому смена часов на экране не требует переустановки. Здесь нужен
    только интервал сторожа N: он берётся из настроек при установке; сменили его на экране - запустите скрипт ещё
    раз (сторож предупредит об этом в журнале). Старые задания JvxPult-utro, -den и -vecher при установке снимаются:
    их работу делает сторож.

    Задания идут от имени текущего пользователя и только пока он вошёл в Windows: пароль не запрашивается
    и не хранится (LogonType Interactive). Если компьютер был выключен в час запуска, пропущенное окно не
    догоняется: утренний запуск в обед не нужен, его место займёт дневной.

    Запуск адъютанта идёт на подписке продакта в его Claude Code на этом компьютере. Сервер в этом не участвует.

    Сначала проверить, ничего не меняя:  powershell -File install-windows.ps1 -WhatIf

.PARAMETER KitPath   Каталог набора (по умолчанию родитель каталога скрипта).
.PARAMETER NodePath  Путь к node.exe (по умолчанию из PATH). Нужен Node 20 или новее.
.PARAMETER Prefix    Префикс имён заданий.
.PARAMETER VoicePython  Python окружения с моделью GigaAM. Нет такого файла — задание голоса не ставится, остальные ставятся.
.PARAMETER WatchdogMinutes  Интервал сторожа в минутах. 0 (по умолчанию) - из настроек команды (pult settings), а если сервер
                        недоступен - 5.
.PARAMETER ShowWindow  Не прятать окно консоли при запуске (для отладки).
#>
[CmdletBinding(SupportsShouldProcess = $true)]
param(
    [string]$KitPath,
    [string]$NodePath,
    [string]$Prefix = 'JvxPult',
    [string]$VoicePython = 'D:\gigaam-test\.venv\Scripts\python.exe',
    [int]$WatchdogMinutes = 0,
    [switch]$ShowWindow
)

$ErrorActionPreference = 'Stop'

# При -WhatIf подгрузка модулей Планировщика сыпала бы строки про псевдонимы: на время сборки плана выключаем.
$dryRun = $WhatIfPreference
$WhatIfPreference = $false

# $PSScriptRoot в значении параметра по умолчанию в Windows PowerShell 5.1 пуст, поэтому берётся здесь.
if (-not $KitPath) { $KitPath = Split-Path -Parent $PSScriptRoot }
$kit = (Resolve-Path -LiteralPath $KitPath).Path
$watchdog = Join-Path $kit 'scheduler\watchdog.mjs'
if (-not (Test-Path -LiteralPath $watchdog)) { throw "Не найден $watchdog. Укажите -KitPath." }

if (-not $NodePath) {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw 'node не найден в PATH. Поставьте Node 20 или новее либо укажите -NodePath.' }
    $NodePath = $cmd.Source
}
if (-not (Test-Path -LiteralPath $NodePath)) { throw "Нет файла $NodePath." }

$nodeVersion = (& $NodePath --version).Trim()
if ($nodeVersion -notmatch '^v(\d+)\.' -or [int]$Matches[1] -lt 20) { throw "Нужен Node 20 или новее, найден $nodeVersion." }

foreach ($tool in 'pult', 'claude') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        Write-Warning "$tool не найден в PATH: задания поставятся, но запуски будут падать, пока его нет."
    }
}

# Ритм адъютанта - настройки команды. Интервал сторожа берём с сервера; часы запусков сторож читает сам.
$rhythm = $null
if (Get-Command pult -ErrorAction SilentlyContinue) {
    try {
        # Через cmd: stderr утилиты в Windows PowerShell 5.1 при $ErrorActionPreference = 'Stop' стал бы исключением.
        $raw = cmd /c 'pult settings --section adjutant --json 2>nul'
        if ($LASTEXITCODE -eq 0 -and $raw) { $rhythm = (($raw -join "`n") | ConvertFrom-Json) }
    } catch {
        $rhythm = $null
    }
}
$serverMinutes = 0
if ($rhythm -and $rhythm.settings -and $rhythm.settings.adjutant -and $rhythm.settings.adjutant.watchdog_interval_minutes) {
    $serverMinutes = [int]$rhythm.settings.adjutant.watchdog_interval_minutes
}
$watchdogEvery = if ($WatchdogMinutes -gt 0) { $WatchdogMinutes } elseif ($serverMinutes -ge 1 -and $serverMinutes -le 60) { $serverMinutes } else { 5 }
if (-not $rhythm -and $WatchdogMinutes -le 0) {
    Write-Warning 'Настройки команды не получены (pult settings): сторож ставится с интервалом 5 минут. Проверьте токен и связь, затем запустите скрипт ещё раз.'
}

# Без окна: на Windows 11 консольное приложение можно запустить через conhost --headless.
# Планировщик иначе показывал бы чёрное окно каждые 5 минут.
$conhost = Join-Path $env:SystemRoot 'System32\conhost.exe'
$build = [int](Get-CimInstance Win32_OperatingSystem).BuildNumber
$headless = (-not $ShowWindow) -and $build -ge 22000 -and (Test-Path -LiteralPath $conhost)

function New-WatchdogAction([string]$extra) {
    $script = "`"$watchdog`" $extra".TrimEnd()
    if ($headless) {
        return New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$NodePath`" $script" -WorkingDirectory $kit
    }
    return New-ScheduledTaskAction -Execute $NodePath -Argument $script -WorkingDirectory $kit
}

$user = "$env:USERDOMAIN\$env:USERNAME"
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit (New-TimeSpan -Hours 2)

$plan = @(
    @{ Name = "$Prefix-watchdog"; Trigger = (New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(1)) -RepetitionInterval (New-TimeSpan -Minutes $watchdogEvery) -RepetitionDuration (New-TimeSpan -Days 3650));
                                  Action = (New-WatchdogAction ''); Note = "каждые $watchdogEvery мин, сторож: лента событий и плановые запуски по часам команды" }
)

$voiceWorker = Join-Path $kit 'voice\worker.py'
if (Test-Path -LiteralPath $VoicePython) {
    $voiceArgs = "-B `"$voiceWorker`""
    $voiceAction = if ($headless) {
        New-ScheduledTaskAction -Execute $conhost -Argument "--headless `"$VoicePython`" $voiceArgs" -WorkingDirectory (Join-Path $kit 'voice')
    } else {
        New-ScheduledTaskAction -Execute $VoicePython -Argument $voiceArgs -WorkingDirectory (Join-Path $kit 'voice')
    }
    $plan += @{ Name = "$Prefix-voice"; Trigger = (New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650));
                Action = $voiceAction; Note = 'каждые 5 минут, расшифровка голоса' }
} else {
    Write-Warning "Нет $VoicePython`: расшифровка голоса не ставится. Голосовые останутся нерасшифрованными. Укажите -VoicePython."
}
if (-not (Get-Command ffmpeg -ErrorAction SilentlyContinue)) {
    Write-Warning 'ffmpeg не найден в PATH: расшифровка голоса работать не будет.'
}

Write-Host "Набор:       $kit"
Write-Host "Node:        $NodePath ($nodeVersion)"
Write-Host "Пользователь: $user (запуск только когда вошёл, пароль не хранится)"
Write-Host "Окно:        $(if ($headless) { 'скрыто (conhost --headless)' } else { 'видно' })"
if ($rhythm) {
    $a = $rhythm.settings.adjutant
    Write-Host "Ритм команды: /utro $($a.utro_at), /den $($a.den_at), /vecher $($a.vecher_at) по поясу $($rhythm.team.timezone); их запускает сторож, в Планировщике часов нет"
    $weekdays = @{ '1' = 'понедельник'; '2' = 'вторник'; '3' = 'среда'; '4' = 'четверг'; '5' = 'пятница'; '6' = 'суббота'; '7' = 'воскресенье' }
    $layerDay = $weekdays["$($a.nedelya_day)"]
    if (-not $layerDay) { $layerDay = "день недели $($a.nedelya_day)" }
    if ($a.nedelya_at -and $a.mesyac_at) {
        Write-Host "Слои пульса: /nedelya - $layerDay, не раньше $($a.nedelya_at); /mesyac - в последний рабочий день месяца, не раньше $($a.mesyac_at); оба после вечернего запуска, их тоже запускает сторож"
    } else {
        Write-Warning 'Сервер не отдал день и часы слоёв пульса (/nedelya, /mesyac): сторож возьмёт умолчания, пока сервер не обновят.'
    }
    Write-Host 'Циклы: /cikl и /sprint отдельного расписания не имеют, что пора по циклам, утренний запуск спрашивает у сервера (pult cycle due)'
}
foreach ($t in $plan) {
    Write-Host ("  {0,-18} {1}" -f $t.Name, $t.Note)
    Write-Host ("      {0} {1}" -f $t.Action.Execute, $t.Action.Arguments)
}

# Устаревшие задания старой установки: плановые запуски теперь делает сторож, иначе они сработали бы дважды
# (общий учёт «сегодня уже было» это страхует, но задания были бы мёртвым грузом).
$legacy = @("$Prefix-utro", "$Prefix-den", "$Prefix-vecher") | Where-Object { Get-ScheduledTask -TaskName $_ -ErrorAction SilentlyContinue }
foreach ($name in $legacy) { Write-Host ("  {0,-18} снять: плановый запуск теперь у сторожа" -f $name) }

$WhatIfPreference = $dryRun
foreach ($name in $legacy) {
    if ($PSCmdlet.ShouldProcess($name, 'Снять устаревшее задание')) {
        Unregister-ScheduledTask -TaskName $name -Confirm:$false
        Write-Host "Снято: $name"
    }
}
foreach ($t in $plan) {
    if ($PSCmdlet.ShouldProcess($t.Name, 'Зарегистрировать задание в Планировщике')) {
        Register-ScheduledTask -TaskName $t.Name -Action $t.Action -Trigger $t.Trigger -Settings $settings `
            -Principal $principal -Description 'jvx-pult-kit: адъютант продакта' -Force | Out-Null
        Write-Host "Зарегистрировано: $($t.Name)"
    }
}

# Какой интервал сторожа стоит в Планировщике: сторож сверяет его с настройками команды и предупреждает в журнале,
# если на экране его сменили. Файл пишется без метки BOM: его читает Node.
if ($PSCmdlet.ShouldProcess('schedule.json', 'Записать применённый интервал сторожа')) {
    $stateDir = if ($env:PULT_WATCHDOG_DIR) { $env:PULT_WATCHDOG_DIR } else { Join-Path $env:LOCALAPPDATA 'pult-kit\watchdog' }
    New-Item -ItemType Directory -Force -Path $stateDir | Out-Null
    $applied = @{ watchdog_interval_minutes = $watchdogEvery; installed_at = (Get-Date).ToUniversalTime().ToString('o') } | ConvertTo-Json
    [System.IO.File]::WriteAllText((Join-Path $stateDir 'schedule.json'), $applied, (New-Object System.Text.UTF8Encoding $false))
}
