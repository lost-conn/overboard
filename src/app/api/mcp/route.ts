import { userIdFromBearer } from "@/lib/tokens";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  MCP_PROTOCOL_VERSION,
  RpcError,
  SERVER_INFO,
  failure,
  isJsonRpcRequest,
  success,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from "@/lib/mcp/rpc";
import { TOOLS, asRecord, findTool } from "@/lib/mcp/tools";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request): Promise<Response> {
  const ctx = await userIdFromBearer(request);
  if (!ctx) {
    return new Response("unauthorized", {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(failure(null, RpcError.ParseError, "invalid JSON"));
  }

  if (!isJsonRpcRequest(body)) {
    return Response.json(failure(null, RpcError.InvalidRequest, "not a JSON-RPC 2.0 request"));
  }

  const response = await dispatch(body, ctx);
  // Notifications (no id) get no body per JSON-RPC spec.
  if (body.id === undefined) return new Response(null, { status: 204 });
  return Response.json(response);
}

async function dispatch(
  req: JsonRpcRequest,
  ctx: Awaited<ReturnType<typeof userIdFromBearer>>,
): Promise<JsonRpcResponse> {
  const id: JsonRpcId = req.id ?? null;
  const params = asRecord(req.params);

  try {
    switch (req.method) {
      case "initialize":
        return success(id, {
          protocolVersion:
            typeof params.protocolVersion === "string"
              ? params.protocolVersion
              : MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: SERVER_INFO,
        });

      case "notifications/initialized":
      case "initialized":
        return success(id, {});

      case "ping":
        return success(id, {});

      case "tools/list":
        return success(id, {
          tools: TOOLS.map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.inputSchema,
          })),
        });

      case "tools/call": {
        const name = typeof params.name === "string" ? params.name : "";
        const tool = findTool(name);
        if (!tool) {
          return failure(id, RpcError.MethodNotFound, `unknown tool: ${name}`);
        }
        if (!ctx) {
          return failure(id, RpcError.InternalError, "missing auth context");
        }
        try {
          const result = await tool.handler(ctx, params.arguments);
          return success(id, {
            content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
            structuredContent: result,
            isError: false,
          });
        } catch (err) {
          // Tool errors are reported as JSON-RPC success with isError=true, per MCP spec.
          const message = errorMessage(err);
          return success(id, {
            content: [{ type: "text", text: message }],
            isError: true,
          });
        }
      }

      default:
        return failure(id, RpcError.MethodNotFound, `unknown method: ${req.method}`);
    }
  } catch (err) {
    if (err instanceof ValidationError) {
      return failure(id, RpcError.InvalidParams, err.message);
    }
    if (err instanceof NotFoundError) {
      return failure(id, RpcError.InvalidParams, err.message);
    }
    console.error("[mcp] internal error:", err);
    return failure(id, RpcError.InternalError, errorMessage(err));
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
