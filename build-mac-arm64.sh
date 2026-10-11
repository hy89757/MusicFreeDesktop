#!/usr/bin/env bash
#
# MusicFree Desktop —— 依赖安装 + macOS arm64 DMG 打包脚本
#
# 与 .github/workflows/build.yml 的 build-macos-arm64 任务保持一致，
# 差异仅在于包管理器：仓库已迁移到 npm（pnpm-lock.yaml 已删除），故用 npm ci。
#
# 用法:
#   ./build-mac-arm64.sh                  安装依赖并打包 arm64 DMG（默认）
#   ./build-mac-arm64.sh --clean          打包前清理 out/make 旧产物
#   ./build-mac-arm64.sh --skip-install   跳过依赖安装，直接打包
#   ./build-mac-arm64.sh --arch x64       打其它架构（默认 arm64）
#   ./build-mac-arm64.sh --help
#
# 产物: out/make/MusicFree-<version>-darwin-<arch>.dmg
#
# 注意: 本仓库未配置代码签名与公证（forge.config.ts 无 osxSign/notarize），
#       产出的 DMG 为未签名版本，分发给他人时需对方手动放行 Gatekeeper。
#
set -euo pipefail

# --- 兼容 macOS 自带的 bash 3.2：不使用 mapfile / 关联数组 / ${var,,} 等 4.0+ 特性 ---

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$ROOT_DIR"

# ---------------------------------------------------------------- 输出工具

if [ -t 1 ]; then
    C_RESET=$'\033[0m'; C_DIM=$'\033[2m'; C_RED=$'\033[31m'
    C_GREEN=$'\033[32m'; C_YELLOW=$'\033[33m'; C_CYAN=$'\033[36m'
else
    C_RESET=""; C_DIM=""; C_RED=""; C_GREEN=""; C_YELLOW=""; C_CYAN=""
fi

info() { printf '%s\n' "${C_CYAN}==>${C_RESET} $*"; }
step() { printf '%s\n' "${C_CYAN}==>${C_RESET} ${C_DIM}$*${C_RESET}"; }
ok()   { printf '%s\n' "  ${C_GREEN}✓${C_RESET} $*"; }
warn() { printf '%s\n' "  ${C_YELLOW}!${C_RESET} $*" >&2; }
die()  { printf '%s\n' "${C_RED}  ✗ $*${C_RESET}" >&2; exit 1; }

usage() {
    sed -n '3,19p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'
}

# ---------------------------------------------------------------- 参数解析

ARCH="arm64"
DO_CLEAN=0
SKIP_INSTALL=0

while [ $# -gt 0 ]; do
    case "$1" in
        --arch)
            [ $# -ge 2 ] || die "--arch 需要一个值（arm64 / x64）"
            ARCH="$2"; shift 2 ;;
        --clean)        DO_CLEAN=1; shift ;;
        --skip-install) SKIP_INSTALL=1; shift ;;
        -h|--help)      usage; exit 0 ;;
        *)              usage >&2; die "未知参数: $1" ;;
    esac
done

case "$ARCH" in
    arm64) EXPECT_LIPO="arm64" ;;
    x64)   EXPECT_LIPO="x86_64" ;;
    *)     EXPECT_LIPO="$ARCH" ;;
esac

START_TS=$(date +%s)

# ---------------------------------------------------------------- 1. 环境检查

info "检查构建环境"

[ "$(uname -s)" = "Darwin" ] || die "此脚本只能在 macOS 上运行（当前系统: $(uname -s)）"

command -v node >/dev/null 2>&1 || die "未找到 node，请先安装 Node.js >= 22"
command -v npm  >/dev/null 2>&1 || die "未找到 npm"

NODE_VERSION="$(node -v)"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
# electron@44 的 engines 要求 node >= 22.12.0，CI 亦使用 node 22
[ "$NODE_MAJOR" -ge 22 ] || die "需要 Node.js >= 22（当前 ${NODE_VERSION}）。electron@44 的 engines 字段要求 node >= 22.12.0"

ok "Node ${NODE_VERSION} / npm $(npm -v) / $(uname -m)"

# 原生模块（better-sqlite3 等）在缺少 prebuilt 时需要本地编译，依赖以下工具链。
# 这里只做信息性检查，不自动安装、不改动系统环境。
if ! xcode-select -p >/dev/null 2>&1; then
    warn "未检测到 Xcode Command Line Tools，原生模块若需重新编译会失败"
    warn "安装方式: xcode-select --install"
fi

if command -v python3 >/dev/null 2>&1; then
    PY_VER="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])' 2>/dev/null || echo "")"
    # Python 3.12 起移除了 distutils，node-gyp 需要 setuptools 提供替代实现
    case "$PY_VER" in
        3.1[2-9]|3.[2-9][0-9])
            if ! python3 -c 'import setuptools' >/dev/null 2>&1; then
                warn "Python ${PY_VER} 缺少 setuptools，node-gyp 编译原生模块可能失败"
                warn "CI 的对应处理是: pip install setuptools"
            fi
            ;;
    esac
fi

[ -f package.json ] || die "当前目录未找到 package.json，请在项目根目录运行"

APP_VERSION="$(node -p "require('./package.json').version")"
ok "项目版本 ${APP_VERSION}，目标架构 ${ARCH}"

# ---------------------------------------------------------------- 2. 清理旧产物（需显式开启）

if [ "$DO_CLEAN" -eq 1 ] && [ -d out/make ]; then
    info "清理旧的打包产物 out/make"
    rm -rf out/make
    ok "已清理"
fi

# ---------------------------------------------------------------- 3. 安装依赖

install_deps() {
    # 仓库当前以 npm 为准（.npmrc 指定 registry 且开启 legacy-peer-deps，
    # 后者是该项目安装成功的必要条件，否则会因 peer 冲突 ERESOLVE 失败）
    if [ -f package-lock.json ]; then
        info "按 package-lock.json 精确安装依赖（npm ci）"
        if npm ci; then
            ok "依赖安装完成"
            return 0
        fi
        warn "npm ci 失败，回退到 npm install"
    else
        info "未找到 package-lock.json，使用 npm install"
    fi
    npm install
    ok "依赖安装完成"
}

if [ "$SKIP_INSTALL" -eq 1 ]; then
    info "已指定 --skip-install，跳过依赖安装"
    [ -d node_modules ] || die "node_modules 不存在，无法跳过安装。请去掉 --skip-install"
else
    install_deps
fi

# ---------------------------------------------------------------- 4. 确保 Electron 二进制就位

# package.json 的 allowScripts 白名单未包含 electron，npm 安装时会拦截其安装脚本。
# electron@44 改为在首次 require 时惰性下载，这里显式调用 install.js 提前补齐，
# 避免打包过程中才触发下载。install.js 内部的 isInstalled() 会比对版本，重复执行安全。
info "确保 Electron 二进制就位"
ELECTRON_WANT="$(node -p "require('./node_modules/electron/package.json').version" 2>/dev/null || echo "")"
[ -n "$ELECTRON_WANT" ] || die "未找到 electron 包，依赖可能未安装完整"

ELECTRON_BIN="node_modules/electron/dist/Electron.app/Contents/MacOS/Electron"
ELECTRON_HAVE=""
if [ -f node_modules/electron/dist/version ]; then
    ELECTRON_HAVE="$(tr -d 'v\r\n' < node_modules/electron/dist/version || true)"
fi

if [ -f "$ELECTRON_BIN" ] && [ "$ELECTRON_HAVE" = "$ELECTRON_WANT" ]; then
    ok "Electron ${ELECTRON_WANT} 二进制已就位"
else
    step "需要下载 Electron ${ELECTRON_WANT} 二进制（约 100MB+，视网速耗时较长）"
    # 交叉打包时按目标架构下载对应的 Electron 预编译包
    ELECTRON_INSTALL_PLATFORM=darwin ELECTRON_INSTALL_ARCH="$ARCH" \
        node node_modules/electron/install.js
    [ -f "$ELECTRON_BIN" ] || die "Electron 二进制下载后仍未找到: ${ELECTRON_BIN}"
    ok "Electron ${ELECTRON_WANT} 二进制已就位"
fi

# ---------------------------------------------------------------- 5. 原生模块冒烟测试

# 只验证依赖能被加载、原生绑定可用；不校验其在 Electron ABI 下的表现
# （那一步由 electron-forge 打包时的 rebuild 环节负责）
info "验证原生模块可用性"

if node -e "
    const sharp = require('sharp');
    sharp({ create: { width: 8, height: 8, channels: 3, background: { r: 1, g: 2, b: 3 } } })
        .png().toBuffer().then((b) => {
            if (!b || b.length === 0) throw new Error('sharp 编码结果为空');
        });
" >/dev/null 2>&1; then
    ok "sharp 可正常编解码"
else
    warn "sharp 自检未通过，打包可能失败或应用内图片处理异常"
fi

if node -e "
    const Database = require('better-sqlite3');
    const db = new Database(':memory:');
    db.exec('CREATE TABLE _probe (a INTEGER)');
    db.prepare('INSERT INTO _probe VALUES (?)').run(1);
    db.close();
" >/dev/null 2>&1; then
    ok "better-sqlite3 可正常读写（内存库，未落盘）"
else
    warn "better-sqlite3 自检未通过，原生模块可能未按当前架构编译"
fi

# ---------------------------------------------------------------- 6. 打包 DMG

info "打包 macOS ${ARCH} DMG（NODE_ENV=production）"
step "执行: npm run make -- --arch=${ARCH}"

# 等价于 CI 中的 pnpm run make -- --arch=arm64
# 展开为: cross-env NODE_ENV=production electron-forge make --arch=<arch>
npm run make -- --arch="$ARCH"

ok "electron-forge make 执行完成"

# ---------------------------------------------------------------- 7. 校验产物架构

info "校验产物"

APP_BIN="out/MusicFree-darwin-${ARCH}/MusicFree.app/Contents/MacOS/MusicFree"
if [ -f "$APP_BIN" ]; then
    ACTUAL_ARCHS="$(lipo -archs "$APP_BIN" 2>/dev/null || true)"
    if [ -n "$ACTUAL_ARCHS" ]; then
        case " ${ACTUAL_ARCHS} " in
            *" ${EXPECT_LIPO} "*) ok "App 可执行文件架构为 ${ACTUAL_ARCHS}，与目标 ${ARCH} 一致" ;;
            *) die "App 架构为 ${ACTUAL_ARCHS}，与目标 ${ARCH} 不符" ;;
        esac
    else
        warn "无法读取 App 可执行文件架构（lipo 不可用？）"
    fi
else
    warn "未找到解包产物 ${APP_BIN}，跳过架构校验"
fi

# ---------------------------------------------------------------- 8. 重命名 DMG

# CI 会把 MusicFree-<ver>-<arch>.dmg 重命名为 MusicFree-<ver>-darwin-<arch>.dmg，
# 这里保持同样的命名约定。同时兼容 forge 不同版本将 dmg 放在
# out/make/ 根目录或 out/make/<maker>/ 子目录的两种布局。
[ -d out/make ] || die "打包结束但未找到 out/make 目录，构建可能未真正产出 DMG"

DMG_SRC="$(find out/make -type f -name "*-${ARCH}.dmg" 2>/dev/null | head -n 1 || true)"
if [ -z "$DMG_SRC" ]; then
    DMG_SRC="$(find out/make -type f -name "*.dmg" 2>/dev/null | head -n 1 || true)"
    if [ -n "$DMG_SRC" ]; then
        warn "未按 *-${ARCH}.dmg 匹配到产物，改用找到的第一个 DMG: ${DMG_SRC}"
    fi
fi
[ -n "$DMG_SRC" ] || die "out/make 下未找到任何 .dmg 文件，打包失败"

DMG_FINAL="$(dirname "$DMG_SRC")/MusicFree-${APP_VERSION}-darwin-${ARCH}.dmg"

if [ "$DMG_SRC" != "$DMG_FINAL" ]; then
    if [ -e "$DMG_FINAL" ]; then
        # 同名目标已存在时保留双方，不直接覆盖
        DMG_PREV="${DMG_FINAL%.dmg}.prev.dmg"
        mv "$DMG_FINAL" "$DMG_PREV"
        warn "目标同名文件已存在，旧文件保留为: $(basename "$DMG_PREV")"
    fi
    mv "$DMG_SRC" "$DMG_FINAL"
    ok "已重命名为 $(basename "$DMG_FINAL")"
fi

# ---------------------------------------------------------------- 9. 结果汇总

DMG_SIZE="$(du -h "$DMG_FINAL" 2>/dev/null | cut -f1 | tr -d ' ' || echo "未知")"

if hdiutil verify "$DMG_FINAL" >/dev/null 2>&1; then
    ok "DMG 完整性校验通过（hdiutil verify）"
else
    warn "hdiutil verify 未通过或不可用，请手动确认 DMG 是否可挂载"
fi

if command -v shasum >/dev/null 2>&1; then
    DMG_SHA="$(shasum -a 256 "$DMG_FINAL" 2>/dev/null | cut -d' ' -f1 || true)"
fi

ELAPSED=$(( $(date +%s) - START_TS ))

printf '\n%s\n' "${C_GREEN}打包完成${C_RESET}（耗时 ${ELAPSED}s）"
printf '  %s\n' "产物: ${DMG_FINAL}"
printf '  %s\n' "大小: ${DMG_SIZE}"
if [ -n "${DMG_SHA:-}" ]; then
    printf '  %s\n' "SHA256: ${DMG_SHA}"
fi

cat <<'EOF'

提示:
  * 本仓库未配置代码签名与公证，该 DMG 为未签名版本。
  * 本机自测首次打开: 在 Finder 中右键 App → 打开，或执行
      xattr -dr com.apple.quarantine "/Applications/MusicFree.app"
  * 正式对外分发前需补签名 + 公证，否则用户会被 Gatekeeper 拦截。
EOF
