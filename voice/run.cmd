@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONDONTWRITEBYTECODE=1
if "%PULT_VOICE_PYTHON%"=="" set "PULT_VOICE_PYTHON=D:\gigaam-test\.venv\Scripts\python.exe"
if not exist "%PULT_VOICE_PYTHON%" (
  echo Не найден интерпретатор распознавателя: %PULT_VOICE_PYTHON%. Задайте PULT_VOICE_PYTHON.
  exit /b 2
)
"%PULT_VOICE_PYTHON%" -B "%~dp0worker.py" %*
exit /b %ERRORLEVEL%
