import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const TYPE_CONTAINER_NODES = new Set([
  "TSTypeAnnotation",
  "TSTypeReference",
  "TSTypeQuery",
  "TSTypeLiteral",
  "TSInterfaceDeclaration",
  "TSTypeAliasDeclaration",
  "TSTypeParameterInstantiation",
]);

function isTransactionCallback(fnNode) {
  const parent = fnNode.parent;
  if (!parent || parent.type !== "CallExpression" || parent.arguments[0] !== fnNode) {
    return false;
  }
  const callee = parent.callee;
  return (
    callee &&
    callee.type === "MemberExpression" &&
    !callee.computed &&
    callee.property.type === "Identifier" &&
    callee.property.name === "$transaction"
  );
}

function isTypePosition(node) {
  let cur = node;
  while (cur && cur.parent) {
    const parent = cur.parent;
    if (parent.type === "TSQualifiedName" && parent.right === cur) {
      return true;
    }
    if ((parent.type === "TSAsExpression" || parent.type === "TSSatisfiesExpression") && parent.expression === cur) {
      return false;
    }
    if (TYPE_CONTAINER_NODES.has(parent.type)) {
      return true;
    }
    if (parent.type === "ArrowFunctionExpression" || parent.type === "FunctionExpression") {
      return false;
    }
    cur = parent;
  }
  return false;
}

function isLocalShadowedPrisma(context, node) {
  let scope = context.sourceCode.getScope(node);
  while (scope) {
    const variable = scope.set.get("prisma");
    if (variable) {
      // 模块顶层导入或全局变量仍视作全局 prisma，禁止在事务内使用
      return scope.type !== "module" && scope.type !== "global";
    }
    scope = scope.upper;
  }
  return false;
}

/** 禁止在 $transaction 回调内直接引用全局 prisma，防止单连接池下事务死锁或读到事务外未提交状态 */
export const noPrismaInTransactionRule = {
  meta: {
    type: "problem",
    docs: {
      description: "禁止在 $transaction 回调内引用全局 prisma，应使用回调传入的事务句柄",
    },
    schema: [],
    messages: {
      forbidden: "禁止在 $transaction 回调内直接引用全局 prisma，请传入并使用事务句柄（如 tx）。",
    },
  },
  create(context) {
    let txDepth = 0;
    const enterFn = (node) => {
      if (isTransactionCallback(node)) txDepth += 1;
    };
    const exitFn = (node) => {
      if (isTransactionCallback(node)) txDepth -= 1;
    };
    return {
      ArrowFunctionExpression: enterFn,
      "ArrowFunctionExpression:exit": exitFn,
      FunctionExpression: enterFn,
      "FunctionExpression:exit": exitFn,
      'Identifier[name="prisma"]'(node) {
        if (txDepth <= 0) return;
        const parent = node.parent;
        if (!parent) return;
        if (parent.type === "MemberExpression" && parent.property === node && !parent.computed) return;
        if (parent.type === "Property" && parent.key === node && !parent.shorthand && !parent.computed) return;
        if (isTypePosition(node)) return;
        if (isLocalShadowedPrisma(context, node)) return;
        context.report({ node, messageId: "forbidden" });
      },
    };
  },
};

/** 禁止在 API 路由中直接导入或调用 getServerSession，统一使用 defineApiRoute 或 resolveActor */
export const noDirectGetServerSessionRule = {
  meta: {
    type: "problem",
    docs: {
      description: "禁止在 API 路由中直接调用 getServerSession，应通过 defineApiRoute / resolveActor 统一鉴权",
    },
    schema: [],
    messages: {
      forbidden: "禁止在 API 路由中直接导入或调用 getServerSession，请改用 defineApiRoute 或 getCurrentUser。",
    },
  },
  create(context) {
    return {
      ImportDeclaration(node) {
        if (node.source?.value !== "next-auth") return;
        const hits = node.specifiers?.some(
          (spec) => spec.type === "ImportSpecifier" && spec.imported?.name === "getServerSession",
        );
        if (hits) {
          context.report({ node, messageId: "forbidden" });
        }
      },
      CallExpression(node) {
        if (node.callee?.type === "Identifier" && node.callee.name === "getServerSession") {
          context.report({ node, messageId: "forbidden" });
        }
      },
    };
  },
};

const localPlugin = {
  rules: {
    "no-prisma-in-transaction": noPrismaInTransactionRule,
    "no-direct-get-server-session": noDirectGetServerSessionRule,
  },
};

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 允许用解构剔除字段后取剩余部分，如 const { password, ...rest } = user
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
      // 页面中的图片都是 base64 data URL 或本地 blob URL（题目原图、裁剪预览），next/image 无法优化
      "@next/next/no-img-element": "off",
    },
  },
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/__tests__/**"],
    plugins: {
      local: localPlugin,
    },
    rules: {
      "local/no-prisma-in-transaction": "error",
    },
  },
  {
    files: ["src/app/api/**/*.{ts,tsx}"],
    ignores: ["src/app/api/auth/**"],
    plugins: {
      local: localPlugin,
    },
    rules: {
      "local/no-direct-get-server-session": "error",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
