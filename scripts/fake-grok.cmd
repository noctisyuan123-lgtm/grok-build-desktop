@echo off
rem Mimics `grok --output-format streaming-json` for tests.
rem Windows twin of fake-grok.sh -- keep the modes and emitted lines in sync.
rem Usage: fake-grok.cmd [--ok|--fail|--hang|--slow|--mixed] [--resume SESSION]...
setlocal EnableDelayedExpansion

set "mode=--ok"
set "resume_session="

:parse
if "%~1"=="" goto run
if "%~1"=="--ok" set "mode=--ok" & shift & goto parse
if "%~1"=="--fail" set "mode=--fail" & shift & goto parse
if "%~1"=="--hang" set "mode=--hang" & shift & goto parse
if "%~1"=="--slow" set "mode=--slow" & shift & goto parse
if "%~1"=="--mixed" set "mode=--mixed" & shift & goto parse
if "%~1"=="--resume" (
  set "resume_session=%~2"
  shift
  shift
  goto parse
)
shift
goto parse

:run
if "%mode%"=="--ok" (
  echo {"type":"thought","data":"thinking"}
  if not "%resume_session%"=="" (
    echo {"type":"text","data":"resume:%resume_session%"}
    echo {"type":"end","stopReason":"EndTurn","sessionId":"%resume_session%","requestId":"req-1"}
  ) else (
    echo {"type":"text","data":"hello"}
    echo {"type":"text","data":" world"}
    echo {"type":"end","stopReason":"EndTurn","sessionId":"sess-1","requestId":"req-1"}
  )
  exit /b 0
)

if "%mode%"=="--fail" (
  echo {"type":"thought","data":"trying"}
  echo fake-grok: simulated failure 1>&2
  exit /b 2
)

if "%mode%"=="--hang" (
  echo {"type":"thought","data":"hanging"}
  rem `timeout` refuses to run with redirected stdin; ping is the portable sleep.
  ping -n 601 127.0.0.1 >nul
  exit /b 0
)

if "%mode%"=="--slow" (
  echo {"type":"thought","data":"slow start"}
  ping -n 4 127.0.0.1 >nul
  echo {"type":"text","data":"finally"}
  echo {"type":"end","stopReason":"EndTurn","sessionId":"sess-slow","requestId":"req-slow"}
  exit /b 0
)

if "%mode%"=="--mixed" (
  echo {"type":"thought","data":"start"}
  echo {"type":"future_event","data":"unknown payload"}
  echo {"not":"json valid for our schema either"}
  echo plain text garbage
  echo {"type":"text","data":"recovered"}
  echo {"type":"end","stopReason":"EndTurn","sessionId":"s","requestId":"r"}
  exit /b 0
)

echo unknown mode: %mode% 1>&2
exit /b 1
