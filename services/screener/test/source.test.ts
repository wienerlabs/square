import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { SourceError, TRM_MAX_RESPONSE_BYTES, TrmSanctionsSource } from "../src/index.js";

const fresh = () => privateKeyToAccount(generatePrivateKey()).address;

// An endpoint on a real socket stands where TRM would, and answers what each
// test tells it to. The request goes through the same safeFetch as in
// production; only these tests allow it a loopback address.
describe("what the screener reads from a source", () => {
  let server: Server;
  let port: number;
  let requests = 0;
  let answer: (response: ServerResponse) => void;

  beforeAll(async () => {
    server = createServer((request, response) => {
      requests += 1;
      response.on("error", () => {});
      request.resume();
      request.on("end", () => answer(response));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    requests = 0;
  });

  const local = () => new TrmSanctionsSource(`http://127.0.0.1:${port}`, 5_000, { allowPrivate: true, allowedPorts: [port] });

  it("reads a well-formed answer about every address", async () => {
    const subject = fresh();
    answer = (response) => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify([{ address: subject, isSanctioned: true }]));
    };
    const { sanctioned } = await local().screen([subject]);
    expect(sanctioned.get(subject)).toBe(true);
  });

  it("refuses an answer whose declared length is past the cap, before reading it", async () => {
    answer = (response) => {
      response.writeHead(201, { "content-type": "application/json", "content-length": String(TRM_MAX_RESPONSE_BYTES + 1) });
      response.end("x".repeat(TRM_MAX_RESPONSE_BYTES + 1));
    };
    const error = await local().screen([fresh()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as Error).message).toMatch(/response_too_large/);
  });

  it("stops reading an answer that streams past the cap without declaring a length", async () => {
    const chunk = "x".repeat(16 * 1024);
    answer = (response) => {
      response.writeHead(201, { "content-type": "application/json" });
      let sent = 0;
      const push = (): void => {
        while (sent < 64 * TRM_MAX_RESPONSE_BYTES) {
          sent += chunk.length;
          if (!response.write(chunk)) {
            response.once("drain", push);
            return;
          }
        }
        response.end();
      };
      push();
    };
    const error = await local().screen([fresh()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as Error).message).toMatch(/response_too_large/);
  });

  it("never sends a request to a link-local base URL, such as a cloud metadata endpoint", async () => {
    const error = await new TrmSanctionsSource("http://169.254.169.254", 5_000).screen([fresh()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as Error).message).toMatch(/address_not_public/);
  });

  it("never sends a request to a loopback base URL unless it was allowed", async () => {
    answer = (response) => response.end("[]");
    const error = await new TrmSanctionsSource(`http://127.0.0.1:${port}`, 5_000, { allowedPorts: [port] }).screen([fresh()]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SourceError);
    expect((error as Error).message).toMatch(/address_not_public/);
    expect(requests).toBe(0);
  });
});
