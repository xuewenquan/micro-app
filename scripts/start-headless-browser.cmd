@echo off
rem ============================================================================
rem  启动一个可远程调试的无头 Chromium（供 micro-app 内存分析脚本使用）
rem
rem  为什么需要这个 .cmd：DSH 等受限沙箱里无法创建 Mojo 命名管道 / crashpad，
rem  Chrome 会直接 FATAL 自终止。请在**普通终端**或直接双击本文件运行。
rem
rem  启动后可用：
rem    node scripts\gc_once.js --port=9222 --url-match=localhost:3000 --clear-console
rem    node scripts\cdp_memory_probe.js --port=9222 --url-match=localhost:3000
rem    node scripts\cdp_heap_snapshot.js --port=9222
rem ============================================================================
setlocal

set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"

set "URL=%~2"
if "%URL%"=="" set "URL=http://localhost:3000"

set "PROFILE=%~dp0..\.browser-profile-heap"

rem 优先用 Playwright 缓存的 Chromium；没有则回退到系统 Chrome
set "PW_CACHE=%LOCALAPPDATA%\ms-playwright"
set "EXE="
for /d %%D in ("%PW_CACHE%\chromium-*") do (
  if exist "%%D\chrome-win\chrome.exe" set "EXE=%%D\chrome-win\chrome.exe"
)
if not defined EXE (
  if exist "C:\Program Files\Google\Chrome\Application\chrome.exe" (
    set "EXE=C:\Program Files\Google\Chrome\Application\chrome.exe"
  )
)
if not defined EXE (
  echo [ERROR] 没有找到 Chromium/Chrome，请手动设置 EXE 变量后重试。
  pause
  exit /b 1
)

echo 浏览器  : %EXE%
echo 调试端口: %PORT%
echo 打开地址: %URL%
echo Profile : %PROFILE%
echo.

start "" "%EXE%" ^
  --remote-debugging-port=%PORT% ^
  --remote-allow-origins=* ^
  --user-data-dir="%PROFILE%" ^
  --headless=new ^
  --no-first-run ^
  --no-default-browser-check ^
  --window-size=1600,1000 ^
  --disable-features=CalculateNativeWinOcclusion ^
  --disable-background-timer-throttling ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --js-flags=--expose-gc ^
  "%URL%"

timeout /t 4 /nobreak >nul
echo 校验 CDP ...
curl -s http://127.0.0.1:%PORT%/json/version
echo.
echo 如果上面打印了 Browser 版本号，就说明浏览器已就绪。
echo 关闭：taskkill /IM chrome.exe /FI "WINDOWTITLE eq *headless*" 或按端口找进程。
pause
