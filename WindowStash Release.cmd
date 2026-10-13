@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0"
if errorlevel 1 goto directory_error
where node >nul 2>nul
if errorlevel 1 goto node_error
where npm >nul 2>nul
if errorlevel 1 goto npm_error
where git >nul 2>nul
if errorlevel 1 goto git_error
if not exist "node_modules\marked\package.json" goto dependencies_error
if not exist "companion\node_modules\@tauri-apps\cli\package.json" goto dependencies_error
node "scripts\release.mjs" %*
set "release_exit=%errorlevel%"
if not "%release_exit%"=="0" echo 发布工具已停止，请查看上方错误和恢复提示。
goto finish
:node_error
echo 缺少 Node.js。请安装包含 npm 的 Node.js 22 或更新的 LTS。
goto failed
:npm_error
echo 缺少 npm。请检查包含 npm 的 Node.js 安装。
goto failed
:git_error
echo 缺少 Git。请先安装 Git for Windows。
goto failed
:dependencies_error
echo 缺少项目依赖。请在根目录运行 npm ci，再运行 npm --prefix companion ci。
echo 本启动文件不会自动安装依赖或修改系统设置。
:failed
set "release_exit=1"
:finish
popd
echo.
echo 运行已结束，结果保留在此窗口。按任意键结束。
pause >nul
exit /b %release_exit%
:directory_error
echo 无法进入启动文件所在的项目目录。
pause
exit /b 1
