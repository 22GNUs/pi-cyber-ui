#!/bin/bash

set -e

echo "=========================================="
echo "   Pi Cyber UI - NPM 发布脚本"
echo "=========================================="
echo ""
echo "📦 即将发布包: pi-cyber-ui"
echo ""

# 检查 registry
echo "🔍 检查 npm registry..."
CURRENT_REGISTRY=$(npm config get registry)
if [ "$CURRENT_REGISTRY" != "https://registry.npmjs.org/" ]; then
    echo "⚠️  当前 registry: $CURRENT_REGISTRY"
    echo "   正在切换到官方 npm registry..."
    npm config set registry https://registry.npmjs.org/
    echo "   ✅ 已切换到 https://registry.npmjs.org/"
else
    echo "   ✅ Registry 正确: https://registry.npmjs.org/"
fi
echo ""

# 获取 Token 指引
echo "🔐 需要 NPM Access Token 来完成发布"
echo ""
echo "   📖 Token 获取步骤:"
echo "   1. 登录 https://www.npmjs.com/ 并点击右上角头像"
echo "   2. 选择 "Access Tokens""
echo "   3. 点击 "Generate New Token" → "Granular Access Token""
echo "   3. 配置:"
echo "      - Token Name: pi-cyber-ui-publish (或其他名称)"
echo "      - Packages: 选择 "Only selected packages", 输入 pi-cyber-ui"
echo "      - Permissions: 勾选 Publish"
echo "      - 勾选 "Automatically bypass two-factor authentication""
echo "   4. 点击 Generate, 复制生成的 token (以 npm_ 开头)"
echo ""

# 提示输入 token
read -s -p "   🔑 请输入你的 NPM Access Token: " NPM_TOKEN
echo ""
echo ""

# 验证 token 格式
if [[ ! "$NPM_TOKEN" =~ ^npm_[a-zA-Z0-9]+$ ]]; then
    echo "❌ 错误: Token 格式不正确。NPM Token 应该以 'npm_' 开头"
    echo "   请重新检查你的 token 并再次运行脚本"
    exit 1
fi

echo "✅ Token 格式正确"
echo ""

# 设置 token
echo "⚙️  配置 npm auth token..."
npm config set //registry.npmjs.org/:_authToken "$NPM_TOKEN"
echo "   ✅ Token 已配置"
echo ""

# 验证登录
echo "🔍 验证 npm 登录状态..."
if npm whoami > /dev/null 2>&1; then
    USER=$(npm whoami)
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
echo "📦 准备发布到 npm:"
echo "   包名: pi-cyber-ui"
echo "   版本: $(node -p "require('./package.json').version")"
echo "   Registry: https://registry.npmjs.org/"
echo ""
read -p "   🚀 确认发布? (y/N): " CONFIRM

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
echo "📦 包地址: https://www.npmjs.com/package/pi-cyber-ui"
echo ""
echo "💡 Pi 安装命令:"
echo "   pi theme npm:pi-cyber-ui"
echo ""

# 清理 token（可选）
read -p "🧹 是否从 npm 配置中删除 token? (y/N): " CLEANUP
if [[ "$CLEANUP" =~ ^[Yy]$ ]]; then
    npm config delete //registry.npmjs.org/:_authToken
    echo "   ✅ Token 已删除"
fi

echo ""
echo "🎉 完成!"
