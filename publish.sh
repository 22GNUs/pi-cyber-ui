#!/bin/bash

set -euo pipefail

PACKAGE_NAME="pi-cyber-ui"
REGISTRY="https://registry.npmjs.org/"
AUTH_KEY="//registry.npmjs.org/:_authToken"
SHOULD_BUMP=false
TEMP_NPMRC=""

cleanup() {
    if [ -n "$TEMP_NPMRC" ] && [ -f "$TEMP_NPMRC" ]; then
        rm -f "$TEMP_NPMRC"
    fi
}
trap cleanup EXIT

usage() {
    cat <<EOF
用法: ./publish.sh [--bump]

选项:
  --bump, bump, -b      发布前执行 npm version patch --no-git-tag-version
  -h, --help            显示帮助

认证:
  优先使用 NPM_TOKEN 环境变量（仅写入临时 npmrc，退出时删除）。
  未设置时使用 npm 已有登录状态；脚本不会修改全局 registry 或缓存 token。
EOF
}

for arg in "$@"; do
    case "$arg" in
        --bump|bump|-b)
            SHOULD_BUMP=true
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "❌ 未知参数: $arg"
            usage
            exit 1
            ;;
    esac
done

NPM_ARGS=(--registry "$REGISTRY")
if [ -n "${NPM_TOKEN:-}" ]; then
    TEMP_NPMRC=$(mktemp "${TMPDIR:-/tmp}/pi-cyber-ui-npmrc.XXXXXX")
    chmod 600 "$TEMP_NPMRC"
    {
        printf 'registry=%s\n' "$REGISTRY"
        printf '%s=%s\n' "$AUTH_KEY" "$NPM_TOKEN"
    } > "$TEMP_NPMRC"
    NPM_ARGS+=(--userconfig "$TEMP_NPMRC")
    echo "🔐 使用临时 npmrc 中的 NPM_TOKEN（不会持久化）"
else
    echo "🔐 使用 npm 现有登录状态"
fi

if ! NPM_USER=$(npm whoami "${NPM_ARGS[@]}" 2>/dev/null); then
    echo "❌ npm 登录验证失败"
    echo "   请运行 npm login --registry $REGISTRY"
    echo "   或通过 NPM_TOKEN 环境变量重新执行。"
    exit 1
fi

echo "✅ npm 用户: $NPM_USER"
echo ""
echo "🔍 运行发布前检查..."
npm test
npm run typecheck

echo ""
VERSION=$(node -p "require('./package.json').version")
echo "📦 准备发布:"
echo "   包名: $PACKAGE_NAME"
echo "   当前版本: $VERSION"
echo "   Patch bump: $SHOULD_BUMP"
echo "   Registry: $REGISTRY"
echo ""
read -r -p "   🚀 确认发布? (y/N): " CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo "❌ 发布已取消（未修改版本、registry 或认证配置）"
    exit 0
fi

if [ "$SHOULD_BUMP" = true ]; then
    OLD_VERSION=$VERSION
    npm version patch --no-git-tag-version
    VERSION=$(node -p "require('./package.json').version")
    echo "🔼 版本: $OLD_VERSION → $VERSION"
fi

echo "🚀 正在发布..."
# prepublishOnly 已在上方显式执行；避免 npm publish 再重复运行一次。
npm publish --access public --ignore-scripts "${NPM_ARGS[@]}"

echo ""
echo "✅ 发布成功: $PACKAGE_NAME@$VERSION"
echo "📦 https://www.npmjs.com/package/$PACKAGE_NAME"
echo "💡 pi install npm:$PACKAGE_NAME"
