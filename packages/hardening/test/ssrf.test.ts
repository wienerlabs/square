import { createServer } from "node:http";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  SsrfError,
  assertPublicUrl,
  classifyAddress,
  createPinnedLookup,
  formatIpv4,
  parseIpv4Literal,
  safeFetch,
  safeFetchFollowingRedirects,
} from "../src/ssrf.js";
import type { HostnameLookup, ResolvedAddress, SafeFetchInit, SsrfRejectionCode } from "../src/ssrf.js";

const PUBLIC_V4: ResolvedAddress = { address: "93.184.216.34", family: 4 };
const LOOPBACK_V4: ResolvedAddress = { address: "127.0.0.1", family: 4 };
const LOOPBACK_V6: ResolvedAddress = { address: "::1", family: 6 };

const publicLookup: HostnameLookup = async () => [PUBLIC_V4];

async function rejection(promise: Promise<unknown>): Promise<SsrfError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof SsrfError) return error;
    throw error;
  }
  throw new Error("expected an SsrfError rejection");
}

describe("assertPublicUrl rejects", () => {
  const rejected: Array<[string, SsrfRejectionCode]> = [
    ["http://127.0.0.1/", "address_not_public"],
    ["http://localhost/", "address_not_public"],
    ["http://10.0.0.1/", "address_not_public"],
    ["http://192.168.1.1/", "address_not_public"],
    ["http://172.16.0.1/", "address_not_public"],
    ["http://169.254.169.254/latest/meta-data", "address_not_public"],
    ["http://[::1]/", "address_not_public"],
    ["http://[fe80::1]/", "address_not_public"],
    ["http://[::ffff:127.0.0.1]/", "address_not_public"],
    ["http://0x7f.0.0.1/", "address_not_public"],
    ["http://2130706433/", "address_not_public"],
    ["http://017700000001/", "address_not_public"],
    ["http://127.1/", "address_not_public"],
    ["ftp://example.com/", "unsupported_scheme"],
    ["http://user:pw@example.com/", "credentials_in_url"],
    ["http://example.com:22/", "port_not_allowed"],
  ];
  for (const [url, code] of rejected) {
    it(`${url} as ${code} without consulting DNS`, async () => {
      const lookup = vi.fn(publicLookup);
      const error = await rejection(assertPublicUrl(url, { lookup }));
      expect(error.code).toBe(code);
      expect(lookup).not.toHaveBeenCalled();
    });
  }

  it("a name whose resolution includes a private address", async () => {
    const lookup: HostnameLookup = async () => [PUBLIC_V4, { address: "10.1.2.3", family: 4 }];
    const error = await rejection(assertPublicUrl("https://example.com/", { lookup }));
    expect(error.code).toBe("address_not_public");
    expect(error.message).toContain("10.1.2.3");
  });

  it("a name that resolves to an IPv4-mapped loopback", async () => {
    const lookup: HostnameLookup = async () => [{ address: "::ffff:127.0.0.1", family: 6 }];
    const error = await rejection(assertPublicUrl("https://example.com/", { lookup }));
    expect(error.code).toBe("address_not_public");
  });

  it("a name that resolves to nothing", async () => {
    const error = await rejection(assertPublicUrl("https://example.com/", { lookup: async () => [] }));
    expect(error.code).toBe("no_addresses");
  });

  it("a failing lookup", async () => {
    const lookup: HostnameLookup = async () => {
      throw new Error("ENOTFOUND");
    };
    const error = await rejection(assertPublicUrl("https://example.com/", { lookup }));
    expect(error.code).toBe("dns_lookup_failed");
  });

  it("a numeric host that is not a valid IPv4 literal, before any lookup", async () => {
    const lookup = vi.fn(publicLookup);
    const error = await rejection(assertPublicUrl("http://1.2.3.0x100/", { lookup }));
    expect(["invalid_url", "invalid_host"]).toContain(error.code);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("something that is not a URL", async () => {
    const error = await rejection(assertPublicUrl("not a url"));
    expect(error.code).toBe("invalid_url");
  });
});

describe("assertPublicUrl accepts", () => {
  it("https://example.com/ when the lookup returns a public address", async () => {
    const lookup = vi.fn(publicLookup);
    const validated = await assertPublicUrl("https://example.com/", { lookup });
    expect(validated.hostname).toBe("example.com");
    expect(validated.port).toBe(443);
    expect(validated.addresses).toEqual([PUBLIC_V4]);
    expect(lookup).toHaveBeenCalledWith("example.com");
  });

  it("a public IP literal without any lookup", async () => {
    const lookup = vi.fn(publicLookup);
    const validated = await assertPublicUrl("http://93.184.216.34/path", { lookup });
    expect(validated.addresses).toEqual([PUBLIC_V4]);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("a port that is on the allowlist", async () => {
    const validated = await assertPublicUrl("https://example.com:8443/", { lookup: publicLookup, allowedPorts: [8443] });
    expect(validated.port).toBe(8443);
  });

  it("loopback only when allowPrivate is set", async () => {
    const validated = await assertPublicUrl("http://127.0.0.1/", { allowPrivate: true });
    expect(validated.addresses).toEqual([LOOPBACK_V4]);
  });
});

describe("parseIpv4Literal", () => {
  it.each([
    ["0x7f.1", "127.0.0.1"],
    ["0x7f.0.0.1", "127.0.0.1"],
    ["2130706433", "127.0.0.1"],
    ["017700000001", "127.0.0.1"],
    ["127.1", "127.0.0.1"],
    ["0177.0.0.1", "127.0.0.1"],
    ["0xA9FEA9FE", "169.254.169.254"],
    ["10.0.1", "10.0.0.1"],
    ["192.168.257", "192.168.1.1"],
    ["127.0.0.1.", "127.0.0.1"],
    ["0x", "0.0.0.0"],
  ])("%s is %s", (literal, dotted) => {
    const value = parseIpv4Literal(literal);
    expect(value === undefined ? undefined : formatIpv4(value)).toBe(dotted);
  });

  it.each(["example.com", "256.1.1.1", "1.2.3.4.5", "", "1.2.3.0x100", "0x7g.1", "1..2"])(
    "%s is not an IPv4 literal",
    (host) => {
      expect(parseIpv4Literal(host)).toBeUndefined();
    }
  );
});

describe("classifyAddress", () => {
  it.each([
    ["8.8.8.8", "public"],
    ["93.184.216.34", "public"],
    ["172.32.0.1", "public"],
    ["0.0.0.0", "unspecified"],
    ["127.0.0.1", "loopback"],
    ["127.255.255.254", "loopback"],
    ["10.0.0.1", "private"],
    ["100.64.0.1", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.0.1", "private"],
    ["169.254.169.254", "link_local"],
    ["224.0.0.1", "multicast"],
    ["255.255.255.255", "reserved"],
    ["198.18.0.1", "reserved"],
    ["203.0.113.9", "reserved"],
    ["::", "unspecified"],
    ["::1", "loopback"],
    ["fe80::1", "link_local"],
    ["fe80::1%lo0", "link_local"],
    ["fc00::1", "private"],
    ["fd12:3456::1", "private"],
    ["ff02::1", "multicast"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:7f00:1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:8.8.8.8", "public"],
    ["::7f00:1", "loopback"],
    ["2002:7f00:1::", "loopback"],
    ["2002:808:808::", "public"],
    ["2001:0:808:808::80ff:fffe", "loopback"],
    ["2001:0:808:808::f7f7:f7f7", "public"],
    ["64:ff9b::7f00:1", "loopback"],
    ["64:ff9b::808:808", "public"],
    ["64:ff9b:1::1", "private"],
    ["100::1", "reserved"],
    ["2001:db8::1", "reserved"],
    ["2606:4700::1111", "public"],
    ["not-an-ip", "invalid"],
    ["127.1", "invalid"],
  ])("%s is %s", (address, scope) => {
    expect(classifyAddress(address)).toBe(scope);
  });
});

describe("createPinnedLookup", () => {
  it("answers with the pre-validated addresses and never resolves again, even when DNS now says loopback", async () => {
    const lookup = vi.fn<HostnameLookup>().mockResolvedValueOnce([PUBLIC_V4]).mockResolvedValue([LOOPBACK_V4]);
    const validated = await assertPublicUrl("https://example.com/", { lookup });
    const pinned = createPinnedLookup(validated.addresses);

    const all = await new Promise<unknown>((resolve, reject) => {
      pinned("example.com", { all: true }, (error, addresses) => (error ? reject(error) : resolve(addresses)));
    });
    expect(all).toEqual([PUBLIC_V4]);

    const single = await new Promise<[unknown, number | undefined]>((resolve, reject) => {
      pinned("example.com", {}, (error, address, family) => (error ? reject(error) : resolve([address, family])));
    });
    expect(single).toEqual([PUBLIC_V4.address, 4]);
    expect(lookup).toHaveBeenCalledTimes(1);

    const revalidated = await rejection(assertPublicUrl("https://example.com/", { lookup }));
    expect(revalidated.code).toBe("address_not_public");
    expect(lookup).toHaveBeenCalledTimes(2);
  });

  it("filters by the family the socket asks for and fails closed when nothing matches", async () => {
    const pinned = createPinnedLookup([PUBLIC_V4]);
    const error = await new Promise<Error | null>((resolve) => {
      pinned("example.com", { family: 6 }, (failure) => resolve(failure));
    });
    expect(error?.message).toContain("no pinned address for family 6");
  });
});

describe("safeFetch against a local server", () => {
  let server: Server;
  let port = 0;
  const seen: Array<{ url: string; host: string | undefined; method: string }> = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({ url: req.url ?? "", host: req.headers.host, method: req.method ?? "" });
      switch (req.url) {
        case "/redirect":
          res.writeHead(302, { location: "/final" });
          res.end();
          return;
        case "/redirect-to-port-22":
          res.writeHead(302, { location: "http://127.0.0.1:22/" });
          res.end();
          return;
        case "/loop":
          res.writeHead(302, { location: "/loop" });
          res.end();
          return;
        case "/see-other":
          res.writeHead(303, { location: "/echo-method" });
          res.end();
          return;
        case "/echo-method":
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(req.method);
          return;
        case "/chunked-big":
          res.writeHead(200, { "content-type": "application/octet-stream" });
          for (let i = 0; i < 4; i += 1) res.write(Buffer.alloc(1024, i));
          res.end();
          return;
        case "/declared-big":
          res.writeHead(200, { "content-type": "application/octet-stream", "content-length": "4096" });
          res.end(Buffer.alloc(4096, 1));
          return;
        case "/slow": {
          const timer = setTimeout(() => res.end("late"), 5_000);
          res.on("close", () => clearTimeout(timer));
          return;
        }
        case "/no-content":
          res.writeHead(204);
          res.end();
          return;
        default:
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(`hello from ${req.url}`);
      }
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  const local = (path: string): string => `http://pinned.test:${port}${path}`;
  const loopbackLookup = (): HostnameLookup => vi.fn(async () => [LOOPBACK_V4]);
  const options = (lookup: HostnameLookup, extra: Record<string, unknown> = {}) => ({
    lookup,
    allowPrivate: true,
    allowedPorts: [port],
    timeoutMs: 2_000,
    ...extra,
  });

  it("connects to the address validated up front and never resolves the name again", async () => {
    const lookup = vi.fn<HostnameLookup>().mockResolvedValueOnce([LOOPBACK_V4]).mockResolvedValue([LOOPBACK_V6]);
    const response = await safeFetch(local("/pinned"), {}, options(lookup));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from /pinned");
    expect(response.url).toBe(local("/pinned"));
    expect(lookup).toHaveBeenCalledTimes(1);
    expect(seen.at(-1)).toEqual({ url: "/pinned", host: `pinned.test:${port}`, method: "GET" });
  });

  it("fails when the pinned address is unreachable instead of re-resolving to one that would work", async () => {
    const lookup = vi.fn<HostnameLookup>().mockResolvedValueOnce([LOOPBACK_V6]).mockResolvedValue([LOOPBACK_V4]);
    await expect(safeFetch(local("/pinned"), {}, options(lookup))).rejects.toThrow();
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("returns 3xx responses without following them", async () => {
    const response = await safeFetch(local("/redirect"), {}, options(loopbackLookup()));
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/final");
    await response.body?.cancel();
  });

  it("refuses redirect: follow up front", async () => {
    const init = { redirect: "follow" } as unknown as SafeFetchInit;
    const error = await rejection(safeFetch(local("/redirect"), init, options(loopbackLookup())));
    expect(error.code).toBe("redirect_follow_not_allowed");
  });

  it("safeFetchFollowingRedirects re-validates every hop", async () => {
    const lookup = loopbackLookup();
    const response = await safeFetchFollowingRedirects(local("/redirect"), {}, options(lookup));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("hello from /final");
    expect(lookup).toHaveBeenCalledTimes(2);

    const error = await rejection(safeFetchFollowingRedirects(local("/redirect-to-port-22"), {}, options(lookup)));
    expect(error.code).toBe("port_not_allowed");
  });

  it("stops after maxRedirects", async () => {
    const lookup = loopbackLookup();
    const error = await rejection(safeFetchFollowingRedirects(local("/loop"), {}, options(lookup, { maxRedirects: 2 })));
    expect(error.code).toBe("too_many_redirects");
    expect(lookup).toHaveBeenCalledTimes(3);
  });

  it("switches to GET and drops the body after a 303", async () => {
    const response = await safeFetchFollowingRedirects(
      local("/see-other"),
      { method: "POST", body: "payload", headers: { "content-type": "text/plain" } },
      options(loopbackLookup())
    );
    expect(await response.text()).toBe("GET");
  });

  it("caps a chunked body while streaming", async () => {
    const response = await safeFetch(local("/chunked-big"), {}, options(loopbackLookup(), { maxResponseBytes: 1024 }));
    expect(response.status).toBe(200);
    await expect(response.arrayBuffer()).rejects.toMatchObject({ code: "response_too_large" });
  });

  it("rejects a declared content-length above the cap before reading", async () => {
    const error = await rejection(safeFetch(local("/declared-big"), {}, options(loopbackLookup(), { maxResponseBytes: 1024 })));
    expect(error.code).toBe("response_too_large");
  });

  it("times out", async () => {
    const error = await rejection(safeFetch(local("/slow"), {}, options(loopbackLookup(), { timeoutMs: 100 })));
    expect(error.code).toBe("timeout");
  });

  it("passes through responses without a body", async () => {
    const response = await safeFetch(local("/no-content"), {}, options(loopbackLookup()));
    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });
});
