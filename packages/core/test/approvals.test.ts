// The approval pipeline's tests, run for both AI actors that work through MCP tools: an external
// MCP client and the in-app assistant (stage 7 AC 3). The suite itself is approval-suite.ts.
import { describe } from "vitest";
import { approvalSuite } from "./approval-suite.ts";

describe("as an MCP client", () => approvalSuite("mcp"));
describe("as the in-app assistant", () => approvalSuite("assistant"));
