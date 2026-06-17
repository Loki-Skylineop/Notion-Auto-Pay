@echo off
chcp 65001 >nul
setlocal enableextensions enabledelayedexpansion

REM ============================================================
REM  Notion Auto Pay - универсальная сборка и запуск одной командой
REM
REM  Использование:
REM    build.bat                       - собрать фронт + собрать и запустить сервер
REM    build.bat exe                   - только собрать notion-auto-pay.exe без запуска
REM    build.bat run                   - собрать фронт и запустить
REM    build.bat clean                 - удалить артефакты сборки
REM
REM  Защита панели паролем, rate limit включается автоматически:
REM    build.bat --password=МойПароль       - запустить с паролем на вход в панель
REM    build.bat run --password=МойПароль    - то же самое
REM    build.bat --password МойПароль        - пробел вместо = тоже поддерживается
REM    set DASHBOARD_PASSWORD=МойПароль       - либо задать пароль через переменную окружения
REM
REM  Если пароль не задан, панель остаётся открытой: build.bat передаёт серверу
REM  --no-password, поэтому даже оставшийся admin_password в config.yaml не
REM  заблокирует вход.
REM ============================================================

cd /d "%~dp0"
set "BINARY=notion-auto-pay.exe"
set "CMD_PATH=./cmd/notion-manager"

REM --- Разбор аргументов: режим clean/exe/run и --password ---
set "MODE="
set "DASH_PASSWORD="
:parse_args
if "%~1"=="" goto after_args
set "ARG=%~1"
if /i "!ARG!"=="clean" ( set "MODE=clean" & shift & goto parse_args )
if /i "!ARG!"=="exe" ( set "MODE=exe" & shift & goto parse_args )
if /i "!ARG!"=="run" ( set "MODE=run" & shift & goto parse_args )
if /i "!ARG!"=="--password" ( set "DASH_PASSWORD=%~2" & shift & shift & goto parse_args )
if /i "!ARG:~0,11!"=="--password=" ( set "DASH_PASSWORD=!ARG:~11!" & shift & goto parse_args )
echo [warn] неизвестный аргумент пропущен: !ARG!
shift
goto parse_args
:after_args

REM --- Пароль: приоритет у --password, иначе переменная окружения DASHBOARD_PASSWORD ---
if not defined DASH_PASSWORD if defined DASHBOARD_PASSWORD set "DASH_PASSWORD=!DASHBOARD_PASSWORD!"

REM --- Аргументы запуска. Без пароля передаём --no-password, чтобы сервер
REM     игнорировал любой admin_password из config.yaml и панель была реально
REM     открыта, иначе старый пароль из config.yaml блокирует вход. ---
set "RUN_ARGS="
if defined DASH_PASSWORD (
  set "RUN_ARGS=--password=!DASH_PASSWORD!"
) else (
  set "RUN_ARGS=--no-password"
)

echo ============================================
echo  Notion Auto Pay: сборка и запуск
echo ============================================

REM --- Режим clean ---
if /i "%MODE%"=="clean" (
  echo [clean] Удаляю артефакты...
  if exist "%BINARY%" del /f /q "%BINARY%"
  if exist "web\dist" rmdir /s /q "web\dist"
  if exist "internal\web\dist" rmdir /s /q "internal\web\dist"
  echo Готово.
  exit /b 0
)

REM --- Проверка инструментов ---
where npm >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] npm не найден. Установите Node.js LTS: https://nodejs.org и перезапустите терминал.
  pause
  exit /b 1
)
where go >nul 2>nul
if errorlevel 1 (
  echo [ОШИБКА] go не найден. Установите Go: https://go.dev/dl/ и перезапустите терминал.
  pause
  exit /b 1
)

REM --- 1/4: зависимости фронтенда ---
echo.
echo [1/4] Зависимости фронтенда...
if not exist "web\node_modules" (
  pushd web
  call npm install
  if errorlevel 1 ( echo [ОШИБКА] npm install не удался & popd & pause & exit /b 1 )
  popd
) else (
  echo      node_modules уже есть, пропускаю npm install
)

REM --- 2/4: сборка фронтенда ---
echo.
echo [2/4] Сборка фронтенда (npm run build)...
pushd web
call npm run build
if errorlevel 1 ( echo [ОШИБКА] npm run build не удался & popd & pause & exit /b 1 )
popd

REM --- 3/4: копирование сборки в internal\web\dist ---
echo.
echo [3/4] Копирование сборки в internal\web\dist...
if exist "internal\web\dist" rmdir /s /q "internal\web\dist"
xcopy "web\dist" "internal\web\dist\" /E /I /Y /Q
if errorlevel 1 ( echo [ОШИБКА] не удалось скопировать web\dist & pause & exit /b 1 )

REM --- 4/4: бэкенд ---
if /i "%MODE%"=="exe" (
  echo.
  echo [4/4] Сборка %BINARY%...
  go build -o %BINARY% %CMD_PATH%
  if errorlevel 1 ( echo [ОШИБКА] go build не удался & pause & exit /b 1 )
  echo Готово: %BINARY% собран.
  echo Запуск без пароля:  %BINARY% --no-password
  echo Запуск с паролем: %BINARY% --password=ВашПароль
  pause
  exit /b 0
)

echo.
echo [4/4] Запуск сервера...
if defined DASH_PASSWORD (
  echo Веб-панель защищена паролем. Включён лимит попыток входа.
  echo Текущий пароль: !DASH_PASSWORD!
) else (
  echo Веб-панель открыта без пароля [--no-password]. Чтобы включить: build.bat --password=ВашПароль
)
echo Дашборд будет доступен на http://localhost:8081/dashboard/
echo Для остановки нажмите Ctrl+C
echo.
go run %CMD_PATH% !RUN_ARGS!

endlocal
