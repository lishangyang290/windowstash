#!/bin/zsh
# Finder uses Terminal for .command files. Locate this checkout even when paths contain spaces.
cd -- "${0:A:h}" || exit 1
export PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/share/fnm/aliases/default/bin:$PATH"
if ! command -v node >/dev/null 2>&1 && [[ -s "$HOME/.nvm/nvm.sh" ]]; then
  source "$HOME/.nvm/nvm.sh"
fi
if ! command -v node >/dev/null 2>&1 && [[ -x "$HOME/.asdf/shims/node" ]]; then
  export PATH="$HOME/.asdf/shims:$PATH"
fi
# Only emphasize failures and the closing hint; respect plain-output preferences.
release_error() {
  if [[ -t 1 && "$TERM" != dumb && -z ${NO_COLOR+x} ]]; then
    printf '\n  \033[31m失败\033[0m  %s\n\n' "$1"
  else
    printf '\n  失败  %s\n\n' "$1"
  fi
}
if ! command -v node >/dev/null 2>&1; then
  release_error '缺少 Node.js。请安装 Node.js 22 或更新的 LTS（nodejs.org），或使用 Homebrew：brew install node。'
elif ! command -v git >/dev/null 2>&1; then
  release_error '缺少 Git。请运行 xcode-select --install 安装命令行工具。'
elif ! command -v npm >/dev/null 2>&1; then
  release_error '缺少 npm。请重新安装包含 npm 的 Node.js LTS。'
elif [[ ! -d node_modules/marked ]]; then
  release_error '缺少发布工具依赖。请先在项目根目录运行 npm ci；本启动文件不会自动安装。'
else
  node scripts/release.mjs "$@"
fi
printf '\n────────────────────────────────────────────────\n\n'
if [[ -t 1 && "$TERM" != dumb && -z ${NO_COLOR+x} ]]; then
  printf '  \033[2m运行已结束，结果保留在此窗口。按回车结束。\033[0m\n\n'
else
  printf '  运行已结束，结果保留在此窗口。按回车结束。\n\n'
fi
read -r
