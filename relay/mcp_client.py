"""Small, fail-closed MCP Streamable HTTP client for Orbit's relay.

Only the current Streamable HTTP POST transport is implemented.  The caller
owns any injected ``http`` request layer; when omitted, :class:`MCPClient`
creates a private ``aiohttp.ClientSession`` with a public-DNS-only resolver.

``connector`` is a mapping (or object with matching attributes) containing
``id``, ``name``, ``url``, optional ``token``, ``enabled`` and the exact
``allowedTools`` list.  ``discover`` returns the remote tool names unchanged;
the parent relay owns any model-facing name prefix mapping.
"""

from __future__ import annotations

import asyncio
import copy
import hashlib
import inspect
import ipaddress
import json
import re
import socket
from dataclasses import dataclass, field
from typing import Any, Mapping
from urllib.parse import urlsplit

import aiohttp


MAX_RESPONSE_BYTES = 512 * 1024
MAX_REQUEST_BYTES = 512 * 1024
REQUEST_TIMEOUT_SECONDS = 10.0
MAX_TOOL_PAGES = 3
MAX_TOOLS = 100
MCP_PROTOCOL_VERSION = "2025-11-25"
SUPPORTED_PROTOCOL_VERSIONS = frozenset({"2025-03-26", "2025-06-18", "2025-11-25"})

__all__ = [
    "MCPClient",
    "MCPError",
    "MCPConfigError",
    "MCPTransportError",
    "MCPProtocolError",
    "MCPRemoteError",
    "MCPResponseLimitError",
    "MCPSSRFError",
    "PublicDNSResolver",
    "validate_connector",
    "validate_endpoint",
]


class MCPError(Exception):
    """Base error for configuration, transport, and protocol refusal."""


class MCPConfigError(MCPError, ValueError):
    """The connector or endpoint is not valid for this client."""


class MCPTransportError(MCPError):
    """The remote endpoint could not be reached or returned HTTP failure."""


class MCPProtocolError(MCPError):
    """The remote response was not a valid bounded MCP/JSON-RPC response."""


class MCPRemoteError(MCPProtocolError):
    """The remote MCP server returned a JSON-RPC or tool-level error."""

    def __init__(self, code: int | None = None, *, tool_error: bool = False):
        self.code = code
        self.tool_error = tool_error
        label = "tool error" if tool_error else "remote MCP error"
        super().__init__(f"{label}{f' ({code})' if code is not None else ''}")


class MCPResponseLimitError(MCPProtocolError):
    """A request or response exceeded the client's byte bound."""


class MCPSSRFError(MCPConfigError, MCPTransportError):
    """A URL or DNS answer points at a non-public destination."""


class _SessionRestarted(Exception):
    """Internal signal: a session expired and the operation must rediscover."""


@dataclass
class _Tool:
    name: str
    description: str
    input_schema: dict[str, Any]
    read_only: bool


@dataclass
class _Session:
    connector_id: str
    url: str
    token_digest: str
    session_id: str | None = None
    protocol_version: str | None = None
    initialized: bool = False
    tools_discovered: bool = False
    tools: dict[str, _Tool] = field(default_factory=dict)


def _bounded_string(value: Any, field_name: str, limit: int) -> str:
    if not isinstance(value, str) or not value.strip() or len(value) > limit:
        raise MCPConfigError(f"invalid connector {field_name}")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in value):
        raise MCPConfigError(f"invalid connector {field_name}")
    return value.strip()


def _connector_value(connector: Any, name: str, default: Any = None) -> Any:
    if isinstance(connector, Mapping):
        return connector.get(name, default)
    return getattr(connector, name, default)


def _hostname_for_dns(host: str) -> str:
    """Return an ASCII DNS name, rejecting literals and local names."""
    if not isinstance(host, str) or not host:
        raise MCPSSRFError("endpoint host is required")
    try:
        # Reject numeric IPv4, IPv6, and IPv6 zone identifiers as endpoints.
        ipaddress.ip_address(host)
    except ValueError:
        pass
    else:
        raise MCPSSRFError("IP-literal endpoints are not allowed")

    try:
        ascii_host = host.encode("idna").decode("ascii").lower().rstrip(".")
    except UnicodeError as error:
        raise MCPSSRFError("endpoint host is not a DNS name") from error
    if ascii_host in {"localhost", "localhost.localdomain", "ip6-localhost", "ip6-loopback"}:
        raise MCPSSRFError("localhost endpoints are not allowed")
    if ascii_host.endswith(".local"):
        raise MCPSSRFError(".local endpoints are not allowed")
    if "." not in ascii_host:
        raise MCPSSRFError("endpoint must be a public DNS name")
    labels = ascii_host.split(".")
    if any(
        not label
        or len(label) > 63
        or not re.fullmatch(r"[a-z0-9](?:[a-z0-9-]*[a-z0-9])?", label)
        for label in labels
    ):
        raise MCPSSRFError("endpoint host is not a DNS name")
    return ascii_host


def validate_endpoint(url: str) -> str:
    """Validate and return an HTTPS endpoint with a public DNS hostname.

    Userinfo and fragments are rejected because they are not needed by MCP and
    make endpoint identity ambiguous.  IP literals and local DNS names are
    rejected before any request or DNS lookup.
    """
    if not isinstance(url, str) or not url or len(url) > 2048:
        raise MCPConfigError("invalid connector url")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in url):
        raise MCPConfigError("invalid connector url")
    if "#" in url:
        raise MCPConfigError("connector url must not contain a fragment")
    try:
        parsed = urlsplit(url)
        username, password, hostname, port = (
            parsed.username,
            parsed.password,
            parsed.hostname,
            parsed.port,
        )
    except ValueError as error:
        raise MCPConfigError("invalid connector url") from error
    if parsed.scheme.lower() != "https" or not hostname or username is not None or password is not None:
        raise MCPConfigError("connector url must be HTTPS without userinfo")
    _hostname_for_dns(hostname)
    if port is not None and not 1 <= port <= 65535:
        raise MCPConfigError("invalid connector url port")
    return url


def validate_connector(connector: Any) -> dict[str, Any]:
    """Validate a connector and return the small normalized config used here."""
    connector_id = _bounded_string(_connector_value(connector, "id"), "id", 64)
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]*", connector_id):
        raise MCPConfigError("invalid connector id")
    name = _bounded_string(_connector_value(connector, "name", connector_id), "name", 256)
    url = validate_endpoint(_connector_value(connector, "url"))

    enabled = _connector_value(connector, "enabled")
    if type(enabled) is not bool:
        raise MCPConfigError("invalid connector enabled flag")

    allowed = _connector_value(connector, "allowedTools")
    if not isinstance(allowed, list) or len(allowed) > MAX_TOOLS:
        raise MCPConfigError("invalid connector allowedTools")
    allowed_tools: list[str] = []
    for tool in allowed:
        value = _bounded_string(tool, "allowedTools entry", 256)
        if "*" in value or "?" in value:
            raise MCPConfigError("allowedTools must contain exact names")
        if value not in allowed_tools:
            allowed_tools.append(value)

    token = _connector_value(connector, "token")
    if token is not None:
        if not isinstance(token, str) or len(token) > 8192:
            raise MCPConfigError("invalid connector token")
        if any(ord(char) < 0x21 or ord(char) > 0x7E for char in token):
            raise MCPConfigError("invalid connector token")
        token = token or None

    return {
        "id": connector_id,
        "name": name,
        "url": url,
        "token": token,
        "enabled": enabled,
        "allowedTools": allowed_tools,
    }


class PublicDNSResolver(aiohttp.abc.AbstractResolver):
    """Resolve DNS and reject every answer that is not a globally routable IP."""

    def __init__(self, resolver: Any = None):
        self._resolver = resolver or aiohttp.resolver.ThreadedResolver()

    async def resolve(self, host: str, port: int = 0, family: int = socket.AF_INET) -> list[dict[str, Any]]:
        _hostname_for_dns(host)
        try:
            records = await self._resolver.resolve(host, port, family)
        except MCPError:
            raise
        except Exception as error:
            raise MCPTransportError("DNS resolution failed") from error
        if not isinstance(records, list) or not records:
            raise MCPTransportError("DNS returned no addresses")

        checked: list[dict[str, Any]] = []
        for record in records:
            if not isinstance(record, Mapping):
                raise MCPSSRFError("DNS returned an invalid address")
            address = record.get("host")
            try:
                ip = ipaddress.ip_address(address)
            except (TypeError, ValueError) as error:
                raise MCPSSRFError("DNS returned a non-IP address") from error
            if not ip.is_global:
                raise MCPSSRFError("DNS returned a non-public address")
            record_family = record.get("family")
            if record_family not in (socket.AF_INET, socket.AF_INET6):
                raise MCPSSRFError("DNS returned a non-IP protocol")
            protocol = record.get("proto", 0)
            if protocol not in (0, socket.IPPROTO_TCP):
                raise MCPSSRFError("DNS returned a non-TCP protocol")
            checked.append(dict(record))
        return checked

    async def close(self) -> None:
        close = getattr(self._resolver, "close", None)
        if close is not None:
            result = close()
            if inspect.isawaitable(result):
                await result


_MISSING = object()


def _json_dumps(value: Any, limit: int, label: str) -> bytes:
    try:
        encoded = json.dumps(
            value,
            ensure_ascii=False,
            separators=(",", ":"),
            allow_nan=False,
        ).encode("utf-8")
    except (TypeError, ValueError, UnicodeEncodeError) as error:
        raise MCPProtocolError(f"invalid {label}") from error
    if len(encoded) > limit:
        raise MCPResponseLimitError(f"{label} exceeds {limit} bytes")
    return encoded


def _json_loads(body: bytes) -> Any:
    def reject_constant(value: str) -> Any:
        raise ValueError(f"invalid JSON constant {value}")

    try:
        return json.loads(body.decode("utf-8"), parse_constant=reject_constant)
    except (UnicodeDecodeError, json.JSONDecodeError, ValueError) as error:
        raise MCPProtocolError("invalid JSON response") from error


def _same_id(actual: Any, expected: int) -> bool:
    return type(actual) is int and actual == expected


def _header(headers: Any, wanted: str) -> str | None:
    if headers is None:
        return None
    if hasattr(headers, "get"):  # aiohttp CIMultiDict and ordinary mappings
        value = headers.get(wanted)
        if value is not None:
            return str(value)
    try:
        for key, value in headers.items():
            if str(key).lower() == wanted.lower():
                return str(value)
    except AttributeError:
        return None
    return None


def _validate_session_id(value: str) -> str:
    if not value or len(value) > 512 or any(not 0x21 <= ord(char) <= 0x7E for char in value):
        raise MCPProtocolError("invalid MCP session id")
    return value


def _sse_messages(body: bytes) -> list[dict[str, Any]]:
    try:
        text = body.decode("utf-8")
    except UnicodeDecodeError as error:
        raise MCPProtocolError("invalid SSE response") from error
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    messages: list[dict[str, Any]] = []
    for event in text.split("\n\n"):
        data: list[str] = []
        for line in event.split("\n"):
            if not line or line.startswith(":"):
                continue
            if line.startswith("data:"):
                value = line[5:]
                data.append(value[1:] if value.startswith(" ") else value)
        if not data or "\n".join(data) == "":
            continue
        message = _json_loads("\n".join(data).encode("utf-8"))
        if not isinstance(message, dict):
            raise MCPProtocolError("SSE data is not a JSON-RPC object")
        messages.append(message)
    return messages


def _response_messages(headers: Any, body: bytes, expected_id: int) -> list[dict[str, Any]]:
    if not body:
        raise MCPProtocolError("MCP response body is empty")
    content_type = (_header(headers, "Content-Type") or "").split(";", 1)[0].strip().lower()
    if content_type == "text/event-stream" or (not content_type and body.lstrip().startswith(b"data:")):
        messages = _sse_messages(body)
    elif content_type in {"", "application/json"}:
        message = _json_loads(body)
        if not isinstance(message, dict):
            raise MCPProtocolError("JSON response is not a JSON-RPC object")
        messages = [message]
    else:
        raise MCPProtocolError("unsupported MCP response media type")

    selected: list[dict[str, Any]] = []
    for message in messages:
        if message.get("jsonrpc") != "2.0":
            raise MCPProtocolError("invalid JSON-RPC version")
        if "method" in message:
            if "id" in message:
                raise MCPProtocolError("server request is unsupported")
            # Notifications/progress are data from the server, not commands.
            continue
        if "id" not in message or not _same_id(message["id"], expected_id):
            raise MCPProtocolError("JSON-RPC response id mismatch")
        selected.append(message)
    if len(selected) != 1:
        raise MCPProtocolError("MCP response for request is missing or duplicated")
    return selected


def _result_from_response(message: dict[str, Any]) -> Any:
    has_result = "result" in message
    has_error = "error" in message
    if has_result == has_error:
        raise MCPProtocolError("JSON-RPC response must contain result or error")
    if has_error:
        error = message["error"]
        if (
            not isinstance(error, Mapping)
            or type(error.get("code")) is not int
            or not isinstance(error.get("message"), str)
        ):
            raise MCPProtocolError("invalid JSON-RPC error")
        raise MCPRemoteError(error["code"])
    return message["result"]


def _validate_schema(schema: Any) -> dict[str, Any]:
    if not isinstance(schema, dict):
        raise MCPProtocolError("tool inputSchema must be an object")
    if schema.get("type") != "object":
        raise MCPProtocolError("tool inputSchema must have type object")
    properties = schema.get("properties", {})
    if not isinstance(properties, dict):
        raise MCPProtocolError("tool inputSchema properties must be an object")
    required = schema.get("required", [])
    if not isinstance(required, list) or any(not isinstance(key, str) for key in required):
        raise MCPProtocolError("tool inputSchema required must be a string list")
    if len(set(required)) != len(required):
        raise MCPProtocolError("tool inputSchema required is invalid")
    _json_dumps(schema, MAX_RESPONSE_BYTES, "tool inputSchema")
    return schema


def _normalize_tool(tool: Any) -> _Tool:
    if not isinstance(tool, Mapping):
        raise MCPProtocolError("tools/list returned an invalid tool")
    name = tool.get("name")
    if not isinstance(name, str) or not 0 < len(name) <= 256:
        raise MCPProtocolError("tool name is invalid")
    if any(ord(char) < 0x20 or ord(char) == 0x7F for char in name):
        raise MCPProtocolError("tool name is invalid")
    description = tool.get("description", "")
    if not isinstance(description, str) or len(description) > 16 * 1024:
        raise MCPProtocolError("tool description is invalid")
    schema = _validate_schema(tool.get("inputSchema"))
    annotations = tool.get("annotations", {})
    if not isinstance(annotations, Mapping):
        raise MCPProtocolError("tool annotations are invalid")
    for hint in ("readOnlyHint", "destructiveHint"):
        if hint in annotations and type(annotations[hint]) is not bool:
            raise MCPProtocolError("tool annotations are invalid")
    return _Tool(
        name=name,
        description=description,
        input_schema=schema,
        read_only=annotations.get("readOnlyHint") is True and annotations.get("destructiveHint") is not True,
    )


class MCPClient:
    """Async MCP Streamable HTTP client used by the relay parent.

    ``http`` may be an injected object exposing ``request(method, url, ...)``;
    this keeps tests local and avoids any real-server dependency.  With
    ``http=None`` a dedicated secure session is created lazily.  ``close``
    closes only that internally-created session, never an injected layer.
    """

    def __init__(self, http: Any = None):
        if isinstance(http, aiohttp.ClientSession):
            resolver = getattr(getattr(http, "connector", None), "_resolver", None)
            if not isinstance(resolver, PublicDNSResolver):
                raise MCPConfigError("injected aiohttp session must use PublicDNSResolver")
        self._injected_http = http
        self._http: Any = None
        self._owned_http = False
        self._closed = False
        self._next_id = 0
        self._sessions: dict[str, _Session] = {}
        # ponytail: one lock serializes all connector sessions; add per-connector locks only if throughput matters.
        self._lock = asyncio.Lock()

    async def close(self) -> None:
        """Close the private aiohttp session, if this client created one."""
        self._closed = True
        if self._owned_http and self._http is not None:
            await self._http.close()
            self._http = None

    async def discover(self, connector: Any) -> list[dict[str, Any]]:
        """Initialize the connector and return its bounded normalized tool list."""
        config = validate_connector(connector)
        if not config["enabled"]:
            raise MCPConfigError("connector is disabled")
        async with self._lock:
            self._ensure_open()
            session = self._session_for(config)
            for attempt in range(2):
                try:
                    tools = await self._discover_locked(config, session)
                    return [
                        {
                            "name": tool.name,
                            "description": tool.description,
                            "inputSchema": copy.deepcopy(tool.input_schema),
                            "readOnly": tool.read_only,
                        }
                        for tool in tools
                    ]
                except _SessionRestarted:
                    if attempt:
                        raise MCPTransportError("MCP session restarted repeatedly")
            raise AssertionError("unreachable")

    async def call(self, connector: Any, name: str, args: Mapping[str, Any]) -> dict[str, Any]:
        """Call an exactly allowed, currently discovered read-only MCP tool.

        The returned object is the server's bounded ``CallToolResult`` JSON.
        Its text and structured fields are untrusted data; this class does not
        interpret them as instructions.
        """
        config = validate_connector(connector)
        if not config["enabled"]:
            raise MCPConfigError("connector is disabled")
        if not isinstance(name, str) or not 0 < len(name) <= 256:
            raise MCPConfigError("invalid tool name")
        if not isinstance(args, Mapping) or isinstance(args, (list, tuple)):
            raise MCPConfigError("tool arguments must be an object")
        raw_name = name
        _json_dumps(dict(args), MAX_REQUEST_BYTES, "tool arguments")

        async with self._lock:
            self._ensure_open()
            session = self._session_for(config)
            for attempt in range(2):
                try:
                    if not session.tools_discovered:
                        await self._discover_locked(config, session)
                    tool = session.tools.get(raw_name)
                    if tool is None:
                        raise MCPConfigError("tool was not discovered")
                    if not _allowed(config["allowedTools"], raw_name):
                        raise MCPConfigError("tool is not allowed for this connector")
                    if not tool.read_only:
                        raise MCPConfigError("only discovered read-only tools may be called")
                    result = await self._rpc(
                        config,
                        session,
                        {
                            "jsonrpc": "2.0",
                            "id": self._request_id(),
                            "method": "tools/call",
                            "params": {"name": raw_name, "arguments": dict(args)},
                        },
                    )
                    return _validate_tool_result(result)
                except _SessionRestarted:
                    if attempt:
                        raise MCPTransportError("MCP session restarted repeatedly")
            raise AssertionError("unreachable")

    def _ensure_open(self) -> None:
        if self._closed:
            raise MCPError("MCP client is closed")

    def _request_id(self) -> int:
        self._next_id += 1
        return self._next_id

    def _session_for(self, config: dict[str, Any]) -> _Session:
        digest = hashlib.sha256((config["token"] or "").encode("utf-8")).hexdigest()
        old = self._sessions.get(config["id"])
        if old is None or old.url != config["url"] or old.token_digest != digest:
            old = _Session(config["id"], config["url"], digest)
            self._sessions[config["id"]] = old
        return old

    async def _ensure_http(self) -> Any:
        if self._http is not None:
            return self._http
        if self._injected_http is not None:
            self._http = self._injected_http
            return self._http
        resolver = PublicDNSResolver()
        connector = aiohttp.TCPConnector(
            resolver=resolver,
            use_dns_cache=False,
            ssl=True,
            limit=8,
        )
        self._http = aiohttp.ClientSession(
            connector=connector,
            timeout=aiohttp.ClientTimeout(total=REQUEST_TIMEOUT_SECONDS),
            trust_env=False,
            raise_for_status=False,
        )
        self._owned_http = True
        return self._http

    async def _request(self, config: dict[str, Any], session: _Session, message: dict[str, Any]) -> "_HTTPResponse":
        """One request-layer seam: tests may monkeypatch this method locally."""
        body = _json_dumps(message, MAX_REQUEST_BYTES, "MCP request")
        http = await self._ensure_http()
        headers = {
            "Accept": "application/json, text/event-stream",
            "Content-Type": "application/json",
        }
        if config["token"]:
            headers["Authorization"] = f"Bearer {config['token']}"
        if message.get("method") != "initialize":
            if session.session_id:
                headers["Mcp-Session-Id"] = session.session_id
            if session.protocol_version:
                headers["MCP-Protocol-Version"] = session.protocol_version
        try:
            request = http.request(
                "POST",
                config["url"],
                data=body,
                headers=headers,
                allow_redirects=False,
            )
            response = await request if inspect.isawaitable(request) else request
        except MCPError:
            raise
        except asyncio.TimeoutError as error:
            raise MCPTransportError("MCP request timed out") from error
        except Exception as error:
            raise MCPTransportError("MCP request failed") from error

        try:
            status = getattr(response, "status", None)
            if type(status) is not int:
                raise MCPTransportError("MCP response has no status")
            body_bytes = await self._read_body(response)
            return _HTTPResponse(status, getattr(response, "headers", {}), body_bytes)
        finally:
            release = getattr(response, "release", None)
            if release is not None:
                release()

    async def _read_body(self, response: Any) -> bytes:
        content = getattr(response, "content", None)
        if content is not None and hasattr(content, "iter_chunked"):
            chunks: list[bytes] = []
            size = 0
            async for chunk in content.iter_chunked(64 * 1024):
                if not isinstance(chunk, (bytes, bytearray, memoryview)):
                    raise MCPProtocolError("MCP response returned invalid bytes")
                size += len(chunk)
                if size > MAX_RESPONSE_BYTES:
                    raise MCPResponseLimitError("MCP response exceeds 512 KB")
                chunks.append(bytes(chunk))
            return b"".join(chunks)
        read = getattr(response, "read", None)
        if read is None:
            raise MCPProtocolError("MCP response cannot be read")
        value = await read()
        if isinstance(value, str):
            value = value.encode("utf-8")
        if not isinstance(value, (bytes, bytearray, memoryview)):
            raise MCPProtocolError("MCP response returned invalid bytes")
        value = bytes(value)
        if len(value) > MAX_RESPONSE_BYTES:
            raise MCPResponseLimitError("MCP response exceeds 512 KB")
        return value

    async def _rpc(self, config: dict[str, Any], session: _Session, message: dict[str, Any]) -> Any:
        expected_id = message.get("id")
        if type(expected_id) is not int:
            raise MCPProtocolError("MCP request id is invalid")
        response = await self._timed_request(config, session, message)
        if response.status == 404 and session.session_id and message.get("method") != "initialize":
            self._reset_session(session)
            await self._initialize(config, session)
            raise _SessionRestarted()
        _check_http_status(response.status)
        message_list = _response_messages(response.headers, response.body, expected_id)
        if message.get("method") == "initialize":
            self._accept_session_header(session, response.headers, initializing=True)
        else:
            self._accept_session_header(session, response.headers, initializing=False)
        return _result_from_response(message_list[0])

    async def _initialize(self, config: dict[str, Any], session: _Session) -> None:
        if session.initialized:
            return
        result = await self._rpc(
            config,
            session,
            {
                "jsonrpc": "2.0",
                "id": self._request_id(),
                "method": "initialize",
                "params": {
                    "protocolVersion": MCP_PROTOCOL_VERSION,
                    "capabilities": {},
                    "clientInfo": {"name": "orbit-relay", "version": "1.0.0"},
                },
            },
        )
        if not isinstance(result, Mapping) or not isinstance(result.get("protocolVersion"), str):
            raise MCPProtocolError("initialize result is invalid")
        protocol_version = result["protocolVersion"]
        if protocol_version not in SUPPORTED_PROTOCOL_VERSIONS:
            raise MCPProtocolError("unsupported MCP protocol version")
        session.protocol_version = protocol_version
        response = await self._timed_request(
            config,
            session,
            {"jsonrpc": "2.0", "method": "notifications/initialized"},
        )
        _check_http_status(response.status)
        if response.body:
            raise MCPProtocolError("initialized notification must have an empty response")
        session.initialized = True

    async def _timed_request(
        self, config: dict[str, Any], session: _Session, message: dict[str, Any]
    ) -> "_HTTPResponse":
        try:
            return await asyncio.wait_for(
                self._request(config, session, message), REQUEST_TIMEOUT_SECONDS
            )
        except asyncio.TimeoutError as error:
            raise MCPTransportError("MCP request timed out") from error

    async def _discover_locked(self, config: dict[str, Any], session: _Session) -> list[_Tool]:
        await self._initialize(config, session)
        cursor: str | None = None
        seen_cursors: set[str] = set()
        discovered: dict[str, _Tool] = {}
        for page in range(MAX_TOOL_PAGES):
            params = {} if cursor is None else {"cursor": cursor}
            result = await self._rpc(
                config,
                session,
                {
                    "jsonrpc": "2.0",
                    "id": self._request_id(),
                    "method": "tools/list",
                    "params": params,
                },
            )
            if not isinstance(result, Mapping) or not isinstance(result.get("tools"), list):
                raise MCPProtocolError("tools/list result is invalid")
            for item in result["tools"]:
                if len(discovered) >= MAX_TOOLS:
                    raise MCPResponseLimitError("MCP tool list exceeds 100 tools")
                tool = _normalize_tool(item)
                if tool.name in discovered:
                    raise MCPProtocolError("tools/list returned duplicate tool names")
                discovered[tool.name] = tool
            next_cursor = result.get("nextCursor")
            if next_cursor is None or next_cursor == "":
                session.tools = discovered
                session.tools_discovered = True
                return list(discovered.values())
            if not isinstance(next_cursor, str) or len(next_cursor) > 2048:
                raise MCPProtocolError("tools/list cursor is invalid")
            if next_cursor in seen_cursors:
                raise MCPProtocolError("tools/list cursor repeated")
            seen_cursors.add(next_cursor)
            cursor = next_cursor
        raise MCPResponseLimitError("MCP tool pagination exceeds 3 pages")

    def _accept_session_header(self, session: _Session, headers: Any, *, initializing: bool) -> None:
        value = _header(headers, "Mcp-Session-Id")
        if value is None:
            return
        value = _validate_session_id(value)
        if initializing:
            if session.session_id is not None and session.session_id != value:
                raise MCPProtocolError("MCP session id changed unexpectedly")
            session.session_id = value
        elif session.session_id != value:
            raise MCPProtocolError("MCP session id changed unexpectedly")

    @staticmethod
    def _reset_session(session: _Session) -> None:
        session.session_id = None
        session.protocol_version = None
        session.initialized = False
        session.tools_discovered = False
        session.tools.clear()


@dataclass
class _HTTPResponse:
    status: int
    headers: Any
    body: bytes


def _check_http_status(status: int) -> None:
    if 300 <= status < 400:
        raise MCPTransportError("MCP redirects are not allowed")
    if not 200 <= status < 300:
        raise MCPTransportError(f"MCP endpoint returned HTTP {status}")


def _allowed(allowed_tools: list[str], raw_name: str) -> bool:
    return raw_name in allowed_tools


def _validate_tool_result(result: Any) -> dict[str, Any]:
    if not isinstance(result, dict):
        raise MCPProtocolError("tools/call result is invalid")
    if "isError" in result and type(result["isError"]) is not bool:
        raise MCPProtocolError("tools/call isError is invalid")
    if result.get("isError") is True:
        raise MCPRemoteError(tool_error=True)
    content = result.get("content")
    if not isinstance(content, list):
        raise MCPProtocolError("tools/call content is invalid")
    for item in content:
        if not isinstance(item, Mapping) or not isinstance(item.get("type"), str):
            raise MCPProtocolError("tools/call content block is invalid")
        if item["type"] == "text" and not isinstance(item.get("text"), str):
            raise MCPProtocolError("tools/call text content is invalid")
    _json_dumps(result, MAX_RESPONSE_BYTES, "tools/call result")
    return result
