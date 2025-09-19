@echo off
setlocal ENABLEEXTENSIONS
set "REPO=C:\Users\Applicazioni\GC_REPO"

if not exist "%REPO%\autopush.py" (
  echo [ERRORE] Non trovo "%REPO%\autopush.py".
  pause
  exit /b 1
)

pushd "%REPO%"

rem --- Crea venv se manca ---
if not exist ".venv\Scripts\python.exe" (
  echo [SETUP] Creo l'ambiente virtuale...
  where py >nul 2>&1 && (py -3 -m venv .venv) || (python -m venv .venv)
)

set "PY=%CD%\.venv\Scripts\python.exe"
if not exist "%PY%" (
  echo [ERRORE] Python/venv non disponibile. Installa Python 3.x e riprova.
  popd
  pause
  exit /b 1
)

echo [SETUP] Aggiorno pip e dipendenze...
"%PY%" -m pip install --upgrade pip >nul
"%PY%" -m pip show watchdog >nul 2>&1 || ("%PY%" -m pip install watchdog >nul)

echo [RUN] Avvio autopush...
"%PY%" "%REPO%\autopush.py"
set "RC=%ERRORLEVEL%"
echo.
echo [EXIT CODE] %RC%

popd
pause
exit /b %RC%
