#!/usr/bin/env bash
# 构建生产镜像：镜像内 ci 阶段运行全部测试，builder 阶段完成生产构建。
# 用法：build-image.sh [完整提交号]；NODE_IMAGE、HTTP(S)_PROXY、NO_PROXY 从环境变量读取。
set -euo pipefail
cd "$(dirname "$0")/.."

head_revision=$(git rev-parse --verify "HEAD^{commit}")
if [[ -n ${1:-} ]]; then
    requested_revision=$(git rev-parse --verify "${1}^{commit}")
    if [[ $requested_revision != "$head_revision" ]]; then
        echo "错误：传入提交 ${1} (${requested_revision}) 与当前 HEAD (${head_revision}) 不一致，请先切换到目标提交再构建。" >&2
        exit 1
    fi
fi

# 版本号取自最近的 v 开头标签（如 v2026.10.20 或 v2026.10.20-3-gabc1234）；没有标签时不传，运行时回退到 package.json
version=$(git describe --tags --match 'v[0-9]*' "$head_revision" 2>/dev/null || true)
revision="$head_revision"
# 工作树存在未提交、未暂存或未跟踪文件时，为镜像 tag 与 APP_REVISION 追加 -dirty 后缀
if [[ -n $(git status --porcelain) ]]; then
    revision="${head_revision}-dirty"
fi
image="${IMAGE_REPOSITORY:-wrong-notebook}:$revision"

args=(--build-arg "APP_REVISION=$revision")
[[ -n ${NODE_IMAGE:-} ]] && args+=(--build-arg "NODE_IMAGE=$NODE_IMAGE")
[[ -n $version ]] && args+=(--build-arg "APP_VERSION=$version")
# 只传入已设置的代理变量，未设置时不覆盖镜像内默认值
for name in HTTP_PROXY HTTPS_PROXY NO_PROXY; do
    [[ -n ${!name:-} ]] && args+=(--build-arg "$name=${!name}")
done

echo "Building $image"
DOCKER_BUILDKIT=1 docker build --progress=plain "${args[@]}" -t "$image" .
echo "Built $image"
