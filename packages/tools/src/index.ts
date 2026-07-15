export * from "./arguments.js";
export * from "./definition.js";
export * from "./executor.js";
export * from "./ledger.js";
export * from "./registry.js";
export * from "./builtins/delay.js";
export * from "./builtins/echo.js";
export * from "./builtins/guarded-echo.js";

import { createDelayTool, type DelayWaiter } from "./builtins/delay.js";
import { createEchoTool } from "./builtins/echo.js";
import { createGuardedEchoTool } from "./builtins/guarded-echo.js";
import { ToolRegistry } from "./registry.js";

export function createBuiltinToolRegistry(options: { readonly delayWaiter?: DelayWaiter } = {}): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(createEchoTool());
  registry.register(createGuardedEchoTool());
  registry.register(createDelayTool(options.delayWaiter));
  return registry;
}
