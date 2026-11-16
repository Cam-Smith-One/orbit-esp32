"""Local-only tests for the relay MCP client; no network or private data."""

import json
import socket
import sys
import unittest

import aiohttp

sys.path.insert(0, str(__import__("pathlib").Path(__file__).parent))

from mcp_client import (  # noqa: E402
    MCPClient,
    MCPConfigError,
    MCPProtocolError,
    MCPTransportError,
    MCPResponseLimitError,
    MCPSSRFError,
    PublicDNSResolver,
)


class FakeResponse:
    def __init__(self, body=b"", status=200, content_type="application/json", headers=None):
        self.status = status
        self.headers = {"Content-Type": content_type, **(headers or {})}
        self._body = body.encode() if isinstance(body, str) else body
        self.released = False

    async def read(self):
        return self._body

    def release(self):
        self.released = True


class FakeHTTP:
    def __init__(self, responder):
        self.responder = responder
        self.requests = []

    async def request(self, method, url, **kwargs):
        payload = json.loads(kwargs["data"])
        self.requests.append((method, url, payload, kwargs))
        return await self.responder(payload, len(self.requests))


def rpc(payload, result=None, *, error=None, headers=None, content_type="application/json"):
    message = {"jsonrpc": "2.0", "id": payload["id"]}
    if error is None:
        message["result"] = result
    else:
        message["error"] = error
    return FakeResponse(json.dumps(message), content_type=content_type, headers=headers)


def connector(**overrides):
    value = {
        "id": "calendar",
        "name": "Local test connector",
        "url": "https://mcp.example.test/mcp",
        "token": "test-token",
        "enabled": True,
        "allowedTools": ["read_events"],
    }
    value.update(overrides)
    return value


READ_TOOL = {
    "name": "read_events",
    "description": "Read event data.",
    "inputSchema": {"type": "object", "properties": {}},
    "annotations": {"readOnlyHint": True, "destructiveHint": False},
}
WRITE_TOOL = {
    "name": "send_mail",
    "description": "Send mail.",
    "inputSchema": {"type": "object", "properties": {}},
    "annotations": {"readOnlyHint": False, "destructiveHint": True},
}


class StaticResolver:
    def __init__(self, records):
        self.records = records

    async def resolve(self, host, port, family):
        return self.records

    async def close(self):
        return None


class MCPClientTests(unittest.IsolatedAsyncioTestCase):
    def test_connector_rejects_ssrf_urls(self):
        for url in (
            "http://mcp.example.test/mcp",
            "https://localhost/mcp",
            "https://service.local/mcp",
            "https://127.0.0.1/mcp",
            "https://user:password@mcp.example.test/mcp",
            "https://mcp.example.test/mcp#fragment",
        ):
            with self.subTest(url=url):
                with self.assertRaises((MCPConfigError, MCPSSRFError)):
                    connector(url=url)
                    # Validation is deliberately invoked before any request.
                    from mcp_client import validate_connector

                    validate_connector(connector(url=url))

    async def test_resolver_rejects_private_answer_and_checks_every_answer(self):
        records = [
            {"hostname": "mcp.example.test", "host": "8.8.8.8", "port": 443,
             "family": socket.AF_INET, "proto": socket.IPPROTO_TCP, "flags": 0},
            {"hostname": "mcp.example.test", "host": "10.0.0.8", "port": 443,
             "family": socket.AF_INET, "proto": socket.IPPROTO_TCP, "flags": 0},
        ]
        resolver = PublicDNSResolver(StaticResolver(records))
        with self.assertRaises(MCPSSRFError):
            await resolver.resolve("mcp.example.test", 443, socket.AF_UNSPEC)
        await resolver.close()

    async def test_redirect_is_not_followed(self):
        async def respond(payload, _number):
            return FakeResponse(status=302, headers={"Location": "https://other.example.test/mcp"})

        http = FakeHTTP(respond)
        client = MCPClient(http)
        try:
            with self.assertRaises(MCPTransportError):
                await client.discover(connector())
        finally:
            await client.close()
        self.assertEqual(len(http.requests), 1)
        self.assertFalse(http.requests[0][3]["allow_redirects"])

    async def test_invalid_tool_schema_is_rejected(self):
        async def respond(payload, _number):
            if payload.get("method") == "initialize":
                return rpc(payload, {"protocolVersion": "2025-11-25"}, headers={"Mcp-Session-Id": "s1"})
            if payload.get("method") == "notifications/initialized":
                return FakeResponse(b"", status=202)
            return rpc(payload, {"tools": [{"name": "read_events", "inputSchema": []}]})

        client = MCPClient(FakeHTTP(respond))
        try:
            with self.assertRaises(MCPProtocolError):
                await client.discover(connector())
        finally:
            await client.close()

    async def test_response_body_is_bounded(self):
        async def respond(_payload, _number):
            return FakeResponse(b"x" * (512 * 1024 + 1), content_type="application/json")

        client = MCPClient(FakeHTTP(respond))
        try:
            with self.assertRaises(MCPResponseLimitError):
                await client.discover(connector())
        finally:
            await client.close()

    async def test_discover_and_call_preserve_session_and_enforce_read_only_allowlist(self):
        def sse(payload):
            return (
                "event: message\n"
                f"data: {json.dumps({'jsonrpc': '2.0', 'id': payload['id'], 'result': {'tools': [READ_TOOL, WRITE_TOOL]}})}\n\n"
            )

        async def respond(payload, _number):
            method = payload.get("method")
            if method == "initialize":
                return rpc(payload, {"protocolVersion": "2025-11-25"}, headers={"Mcp-Session-Id": "s1"})
            if method == "notifications/initialized":
                return FakeResponse(b"", status=202)
            if method == "tools/list":
                return FakeResponse(sse(payload), content_type="text/event-stream")
            return rpc(payload, {"content": [{"type": "text", "text": "untrusted event data"}], "isError": False})

        http = FakeHTTP(respond)
        client = MCPClient(http)
        try:
            tools = await client.discover(connector())
            self.assertEqual([tool["name"] for tool in tools], ["read_events", "send_mail"])
            self.assertTrue(tools[0]["readOnly"])
            self.assertFalse(tools[1]["readOnly"])
            result = await client.call(connector(), "read_events", {})
            self.assertEqual(result["content"][0]["text"], "untrusted event data")
            with self.assertRaises(MCPConfigError):
                await client.call(connector(), "send_mail", {})
            with self.assertRaises(MCPConfigError):
                await client.call(connector(allowedTools=["other"]), "read_events", {})
        finally:
            await client.close()

        self.assertEqual([request[2]["method"] for request in http.requests], [
            "initialize", "notifications/initialized", "tools/list", "tools/call",
        ])
        self.assertEqual(http.requests[2][3]["headers"]["Mcp-Session-Id"], "s1")
        self.assertEqual(http.requests[3][3]["headers"]["Mcp-Session-Id"], "s1")
        self.assertEqual(http.requests[3][2]["params"]["name"], "read_events")

    async def test_mismatched_jsonrpc_id_and_is_error_are_rejected(self):
        async def respond(payload, _number):
            if payload.get("method") == "initialize":
                return rpc(payload, {"protocolVersion": "2025-11-25"})
            if payload.get("method") == "notifications/initialized":
                return FakeResponse(b"", status=202)
            if payload.get("method") == "tools/list":
                return rpc(payload, {"tools": [READ_TOOL]})
            return FakeResponse(json.dumps({
                "jsonrpc": "2.0", "id": payload["id"] + 1,
                "result": {"content": [], "isError": True},
            }))

        client = MCPClient(FakeHTTP(respond))
        try:
            await client.discover(connector())
            with self.assertRaises(MCPProtocolError):
                await client.call(connector(), "read_events", {})
        finally:
            await client.close()

    async def test_injected_aiohttp_session_must_use_public_dns_resolver(self):
        session = aiohttp.ClientSession()
        try:
            with self.assertRaises(MCPConfigError):
                MCPClient(session)
        finally:
            await session.close()


if __name__ == "__main__":
    unittest.main()
