import { LOCAL_RSS_MODE } from "@follow/shared/constants"
import type { MCPService } from "@follow/shared/settings/interface"
import type { UpdateConnectionRequest } from "@follow-app/client-sdk"

import { followApi } from "~/lib/api-client"

const createLocalModeMCPError = () =>
  new Error("Remote MCP services are disabled in local RSS mode")

export const createMCPConnection = async (connectionData: {
  name: string
  transportType: "streamable-http" | "sse"
  url: string
  headers?: Record<string, string>
}) => {
  if (LOCAL_RSS_MODE) {
    throw createLocalModeMCPError()
  }

  return followApi.mcp.createConnection(connectionData)
}

export const fetchMCPConnections = async (): Promise<MCPService[]> => {
  if (LOCAL_RSS_MODE) {
    return []
  }

  const response = await followApi.mcp.getConnections()
  return response.data
}

export const updateMCPConnection = async (
  connectionId: string,
  updateData: Partial<UpdateConnectionRequest>,
) => {
  if (LOCAL_RSS_MODE) {
    throw createLocalModeMCPError()
  }

  return followApi.mcp.updateConnection({ connectionId, ...updateData })
}

export const deleteMCPConnection = async (connectionId: string): Promise<void> => {
  if (LOCAL_RSS_MODE) {
    throw createLocalModeMCPError()
  }

  await followApi.mcp.deleteConnection({ connectionId })
}

export const refreshMCPTools = async (connectionIds?: string[]): Promise<void> => {
  if (LOCAL_RSS_MODE) {
    throw createLocalModeMCPError()
  }

  await followApi.mcp.refreshTools({ connectionIds })
}

export const getMCPTools = async (connectionId: string) => {
  if (LOCAL_RSS_MODE) {
    return []
  }

  const response = await followApi.mcp.getTools({ connectionId })
  return response.data
}

// Query key factory for MCP queries
export const mcpQueryKeys = {
  all: ["mcp"] as const,
  connections: () => [...mcpQueryKeys.all, "connections"] as const,
  tools: (connectionId: string) => [...mcpQueryKeys.all, "tools", connectionId] as const,
}
