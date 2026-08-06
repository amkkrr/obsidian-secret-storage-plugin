import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // 每个测试后自动恢复 spy/mock，避免 mock 历史跨测试残留
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      // src/ui.ts 依赖 obsidian DOM API（Modal/Setting/Notice），由 RFC §8 手动验收覆盖
      exclude: ["src/ui.ts"],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 80
      }
    }
  }
});
