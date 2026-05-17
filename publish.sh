#!/bin/bash

set -euo pipefail

PACKAGE_NAME="pi-cyber-ui"
REGISTRY="https://registry.npmjs.org/"
AUTH_KEY="//registry.npmjs.org/:_authToken"
SHOULD_BUMP=false
FORGET_TOKEN=false

usage() {
    cat <<EOF
用法: ./publish.sh [--bump] [--forget-token]

选项:
  --bump, bump, -b      发布前执行 npm version patch --no-git-tag-version
  --forget-token        发布完成后删除 npm config 中缓存的 token
  -h, --help            显示帮助
EOF
}

for arg in "$@"; do
    case "$arg" in
        --bump|bump|-b)
            SHOULD_BUMP=true
            ;;
        --forget-token)
            FORGET_TOKEN=true
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

echo "=========================================="
echo "   Pi Cyber UI - NPM 发布脚本"
echo "=========================================="
echo ""
echo "📦 即将发布包: $PACKAGE_NAME"
echo ""

# 检查 registry
echo "🔍 检查 npm registry..."
CURRENT_REGISTRY=$(npm config get registry)
if [ "$CURRENT_REGISTRY" != "$REGISTRY" ]; then
    echo "⚠️  当前 registry: $CURRENT_REGISTRY"
    echo "   正在切换到官方 npm registry..."
    npm config set registry "$REGISTRY"
    echo "   ✅ 已切换到 $REGISTRY"
else
    echo "   ✅ Registry 正确: $REGISTRY"
fi
echo ""

# 可选 bump
if [ "$SHOULD_BUMP" = true ]; then
    OLD_VERSION=$(node -p "require('./package.json').version")
    echo "🔼 升级版本..."
    npm version patch --no-git-tag-version
    NEW_VERSION=$(node -p "require('./package.json').version")
    echo "   ✅ $OLD_VERSION → $NEW_VERSION"
    echo ""
fi

# Token: env 优先，其次 npm config 缓存，最后交互输入
get_cached_token() {
    local token
    token=$(npm config get "$AUTH_KEY" 2>/dev/null || true)
    if [ "$token" = "undefined" ] || [ "$token" = "null" ]; then
        token=""
    fi
    printf '%s' "$token"
}

NPM_TOKEN="${NPM_TOKEN:-}"
if [ -n "$NPM_TOKEN" ]; then
    echo "🔐 使用环境变量 NPM_TOKEN"
else
    NPM_TOKEN=$(get_cached_token)
    if [ -n "$NPM_TOKEN" ]; then
        echo "🔐 使用 npm config 中缓存的 token"
    fi
fi

if [ -z "$NPM_TOKEN" ]; then
    echo "🔐 需要 NPM Access Token 来完成发布"
    echo ""
    echo "   📖 Token 获取步骤:"
    echo "   1. 登录 https://www.npmjs.com/ 并点击右上角头像"
    echo "   2. 选择 Access Tokens"
    echo "   3. 点击 Generate New Token → Granular Access Token"
    echo "   4. 配置:"
    echo "      - Token Name: pi-cyber-ui-publish (或其他名称)"
    echo "      - Packages: 选择 Only selected packages，输入 $PACKAGE_NAME"
    echo "      - Permissions: 勾选 Publish"
    echo "      - 勾选 Automatically bypass two-factor authentication"
    echo "   5. 点击 Generate，复制生成的 token (以 npm_ 开头)"
    echo ""
    read -r -s -p "   🔑 请输入你的 NPM Access Token: " NPM_TOKEN
    echo ""
    echo ""
fi

# 验证 token 格式
if [[ ! "$NPM_TOKEN" =~ ^npm_[a-zA-Z0-9]+$ ]]; then
    echo "❌ 错误: Token 格式不正确。NPM Token 应该以 'npm_' 开头"
    echo "   请重新检查你的 token 并再次运行脚本"
    exit 1
fi

echo "✅ Token 格式正确"
echo ""

# 缓存 token 到 npm config，后续发布复用
echo "⚙️  配置 npm auth token..."
npm config set "$AUTH_KEY" "$NPM_TOKEN"
echo "   ✅ Token 已配置并缓存到 npm config"
echo ""

# 验证登录
echo "🔍 验证 npm 登录状态..."
if USER=$(npm whoami 2>/dev/null); then
    echo "   ✅ 已登录为: $USER"
else
    echo "⚠️  警告: 无法验证登录状态，但会继续尝试发布"
fi
echo ""

# 运行类型检查
echo "🔍 运行类型检查..."
npm run typecheck
echo "   ✅ 类型检查通过"
echo ""

# 确认发布
VERSION=$(node -p "require('./package.json').version")
echo "📦 准备发布到 npm:"
echo "   包名: $PACKAGE_NAME"
echo "   版本: $VERSION"
echo "   Registry: $REGISTRY"
echo ""
read -r -p "   🚀 确认发布? (y/N): " CONFIRM

if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
    echo ""
    echo "❌ 发布已取消"
    exit 0
fi

echo ""
echo "🚀 正在发布..."
npm publish --access public

echo ""
echo "=========================================="
echo "   ✅ 发布成功!"
echo "=========================================="
echo ""
echo "📦 包地址: https://www.npmjs.com/package/$PACKAGE_NAME"
echo ""
echo "💡 Pi 安装命令:"
echo "   pi theme npm:$PACKAGE_NAME"
echo ""

if [ "$FORGET_TOKEN" = true ]; then
    echo "🧹 删除 npm config 中缓存的 token..."
    npm config delete "$AUTH_KEY"
    echo "   ✅ Token 已删除"
else
    echo "🔐 Token 已保留在 npm config，下次发布无需重新输入"
fi

echo ""
echo "🎉 完成!"
