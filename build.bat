@echo off
chcp 65001 >nul
setlocal enableextensions enabledelayedexpansion

REM ============================================================
REM  Motion Pay - универсальная сборка и запуск одной командой
REM
REM  Использование:
REM    build.bat            - собрать фронт + собрать и запустить сервер
REM    build.bat exe        - только собрать motion-pay.exe (без запуска)
REM    build.bat run        - собрать фронт и запустить (эквивалент без аргументов)
REM    build.bat clean      - удалить артефакты сборки
REM ============================================================

cd /d "%~dp0"
set "BINARY=motion-pay.exe"
set "CMD_PATH=./cmd/notion-manager"
set "MODE=%~1"

echo ============================================
echo  Motion Pay: сборка и запуск
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
  echo Запустить: %BINARY%
  pause
  exit /b 0
)

echo.
echo [4/4] Запуск сервера (go run %CMD_PATH%)...
echo Дашборд будет доступен на http://localhost:8081/dashboard/
echo Для остановки нажмите Ctrl+C
echo.
go run %CMD_PATH%

endlocal
