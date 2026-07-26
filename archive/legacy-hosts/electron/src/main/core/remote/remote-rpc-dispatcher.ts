import { logger } from "../logger";
import {
  RemoteMethodRegistry,
  RemoteRpcValidationError,
  type RemoteRpcEffect,
  type RemoteRpcScope
} from "./remote-method-registry";

export type RemoteRpcErrorCode =
  | "INVALID_REQUEST"
  | "METHOD_NOT_FOUND"
  | "FORBIDDEN"
  | "INVALID_ARGUMENTS"
  | "HANDLER_FAILED";

export interface RemoteRpcRequest {
  method: string;
  args: unknown[];
}

export interface RemoteRpcDispatchContext {
  readonly grantedScopes: ReadonlySet<RemoteRpcScope> | readonly RemoteRpcScope[];
  readonly clientId?: string;
  readonly requestId?: string;
}

interface RemoteRpcAuditLogger {
  info(message: string, context?: Record<string, unknown>): void;
  warn(message: string, context?: Record<string, unknown>): void;
  error(message: string, context?: Record<string, unknown>): void;
}

export class RemoteRpcError extends Error {
  constructor(
    readonly code: RemoteRpcErrorCode,
    message: string,
    readonly statusCode: number
  ) {
    super(message);
    this.name = "RemoteRpcError";
  }
}

/** 对远程请求执行协议校验、scope 授权、参数校验、调用和结果脱敏。 */
export class RemoteRpcDispatcher {
  constructor(
    private readonly registry: RemoteMethodRegistry,
    private readonly auditLogger: RemoteRpcAuditLogger = logger
  ) {}

  async dispatch(rawRequest: unknown, context: RemoteRpcDispatchContext): Promise<unknown> {
    const request = parseRequest(rawRequest);
    const definition = this.registry.get(request.method);
    if (!definition) {
      this.auditLogger.warn("远程 RPC 拒绝未知方法", createAuditContext(context, request.method));
      throw new RemoteRpcError("METHOD_NOT_FOUND", "远程方法不存在", 404);
    }

    if (!hasScope(context.grantedScopes, definition.requiredScope)) {
      this.auditLogger.warn(
        "远程 RPC scope 不足",
        createAuditContext(context, definition.name, definition.effect, definition.requiredScope)
      );
      throw new RemoteRpcError("FORBIDDEN", "设备未获得此操作权限", 403);
    }

    let args: unknown[];
    try {
      args = definition.validateArgs(request.args);
    } catch (error) {
      const message = error instanceof RemoteRpcValidationError ? error.message : "远程参数校验失败";
      this.auditLogger.warn(
        "远程 RPC 参数无效",
        createAuditContext(context, definition.name, definition.effect, definition.requiredScope)
      );
      throw new RemoteRpcError("INVALID_ARGUMENTS", message, 400);
    }

    const startedAt = Date.now();
    try {
      const result = await definition.handler(...args);
      const sanitized = definition.sanitizeResult(result);
      this.auditLogger.info("远程 RPC 调用完成", {
        ...createAuditContext(context, definition.name, definition.effect, definition.requiredScope),
        elapsedMs: Date.now() - startedAt
      });
      return sanitized;
    } catch (error) {
      if (error instanceof RemoteRpcError) {
        throw error;
      }
      this.auditLogger.error("远程 RPC 业务调用失败", {
        ...createAuditContext(context, definition.name, definition.effect, definition.requiredScope),
        elapsedMs: Date.now() - startedAt,
        errorType: error instanceof Error ? error.name : typeof error
      });
      throw new RemoteRpcError("HANDLER_FAILED", "远程操作执行失败", 500);
    }
  }
}

function parseRequest(value: unknown): RemoteRpcRequest {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RemoteRpcError("INVALID_REQUEST", "远程请求格式无效", 400);
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.some((key) => key !== "method" && key !== "args")) {
    throw new RemoteRpcError("INVALID_REQUEST", "远程请求包含未知字段", 400);
  }
  if (typeof record.method !== "string" || !record.method || record.method.length > 80) {
    throw new RemoteRpcError("INVALID_REQUEST", "远程方法名格式无效", 400);
  }
  if (record.args !== undefined && !Array.isArray(record.args)) {
    throw new RemoteRpcError("INVALID_REQUEST", "远程参数必须是数组", 400);
  }
  const args = record.args ?? [];
  if ((args as unknown[]).length > 4) {
    throw new RemoteRpcError("INVALID_REQUEST", "远程参数数量超过限制", 400);
  }
  return { method: record.method, args: args as unknown[] };
}

function hasScope(
  grantedScopes: ReadonlySet<RemoteRpcScope> | readonly RemoteRpcScope[],
  requiredScope: RemoteRpcScope
): boolean {
  return "has" in grantedScopes ? grantedScopes.has(requiredScope) : grantedScopes.includes(requiredScope);
}

function createAuditContext(
  context: RemoteRpcDispatchContext,
  method: string,
  effect?: RemoteRpcEffect,
  requiredScope?: RemoteRpcScope
): Record<string, unknown> {
  return {
    method,
    effect,
    requiredScope,
    requestId: context.requestId,
    clientId: context.clientId
  };
}
