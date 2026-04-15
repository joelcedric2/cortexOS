import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { docsFetch, DocsFetchError } from "../src/tools/docs-fetch.js";

function mockFetch(
  entries: Array<{
    url?: RegExp | string;
    status?: number;
    headers?: Record<string, string>;
    body: string | Uint8Array;
  }>,
): typeof fetch {
  return (async (input: string | URL | Request): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const entry = entries.find((e) =>
      !e.url ? true : typeof e.url === "string" ? url === e.url : e.url.test(url),
    );
    if (!entry) throw new Error(`mockFetch: no entry matches ${url}`);
    const bodyBuf =
      typeof entry.body === "string" ? new TextEncoder().encode(entry.body) : entry.body;
    const headers = new Headers({
      "content-type": "text/html; charset=utf-8",
      ...(entry.headers ?? {}),
    });
    return new Response(bodyBuf, {
      status: entry.status ?? 200,
      headers,
    });
  }) as typeof fetch;
}

describe("docsFetch — protocol allow-list", () => {
  test("rejects file:// URLs", async () => {
    await assert.rejects(
      () => docsFetch("file:///etc/passwd"),
      (err: unknown) =>
        err instanceof DocsFetchError && err.code === "bad-protocol",
    );
  });

  test("rejects ftp:// URLs", async () => {
    await assert.rejects(
      () => docsFetch("ftp://example.com/readme.txt"),
      (err: unknown) =>
        err instanceof DocsFetchError && err.code === "bad-protocol",
    );
  });

  test("rejects javascript: URLs", async () => {
    await assert.rejects(
      () => docsFetch("javascript:alert(1)"),
      (err: unknown) => err instanceof DocsFetchError,
    );
  });

  test("accepts http:// URLs", async () => {
    const result = await docsFetch("http://example.com/", {
      fetchImpl: mockFetch([{ body: "<html><body>hi</body></html>" }]),
    });
    assert.match(result.text, /hi/);
  });
});

describe("docsFetch — HTML to text extraction", () => {
  test("extracts <title>, strips script/style, collapses whitespace", async () => {
    const html =
      "<html><head><title>  My Page  </title><style>.x{}</style>" +
      "<script>var a = 1;</script></head><body>" +
      "<h1>Hello</h1>\n\n\n<p>World   and   more</p>" +
      "<a href='/next'>next</a><a href='https://example.org/x'>x</a>" +
      "</body></html>";
    const result = await docsFetch("https://example.com/doc", {
      fetchImpl: mockFetch([{ body: html }]),
    });
    assert.equal(result.title, "My Page");
    assert.match(result.text, /Hello/);
    assert.match(result.text, /World and more/);
    assert.doesNotMatch(result.text, /var a = 1/);
    assert.deepEqual(result.links, [
      "https://example.com/next",
      "https://example.org/x",
    ]);
  });

  test("decodes common entities", async () => {
    const html = "<html><body>R&amp;D &lt;strong&gt; &#65;&#x42;</body></html>";
    const result = await docsFetch("https://example.com/", {
      fetchImpl: mockFetch([{ body: html }]),
    });
    assert.match(result.text, /R&D <strong> AB/);
  });

  test("passes through non-HTML text responses as-is", async () => {
    const result = await docsFetch("https://example.com/readme.txt", {
      fetchImpl: mockFetch([
        {
          body: "hello\nworld",
          headers: { "content-type": "text/plain" },
        },
      ]),
    });
    assert.equal(result.text, "hello\nworld");
    assert.equal(result.title, undefined);
  });
});

describe("docsFetch — size + timeout caps", () => {
  test("truncates responses beyond maxBytes", async () => {
    const big = "x".repeat(10 * 1024);
    const result = await docsFetch("https://example.com/big", {
      maxBytes: 1024,
      fetchImpl: mockFetch([
        { body: big, headers: { "content-type": "text/plain" } },
      ]),
    });
    assert.equal(result.truncated, true);
    assert.ok(result.text.length <= 1024);
  });

  test("maps upstream 500 to server-error", async () => {
    await assert.rejects(
      () =>
        docsFetch("https://example.com/oops", {
          fetchImpl: mockFetch([{ status: 503, body: "down" }]),
        }),
      (err: unknown) =>
        err instanceof DocsFetchError && err.code === "server-error",
    );
  });

  test("maps upstream 404 to client-error", async () => {
    await assert.rejects(
      () =>
        docsFetch("https://example.com/missing", {
          fetchImpl: mockFetch([{ status: 404, body: "nope" }]),
        }),
      (err: unknown) =>
        err instanceof DocsFetchError && err.code === "client-error",
    );
  });

  test("times out cleanly via AbortController", async () => {
    const slow: typeof fetch = async (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(new DOMException("aborted", "AbortError"));
        });
      });
    await assert.rejects(
      () =>
        docsFetch("https://example.com/slow", {
          timeoutMs: 50,
          fetchImpl: slow,
        }),
      (err: unknown) => err instanceof DocsFetchError && err.code === "timeout",
    );
  });
});

describe("docsFetch — input validation", () => {
  test("rejects malformed URLs at the zod layer", async () => {
    await assert.rejects(() => docsFetch("not a url"));
  });
});

describe("docsFetch — SSRF host deny-list", () => {
  const makeFetch = () =>
    async () => new Response("should-not-reach", { status: 200 });

  test("rejects AWS/GCP metadata endpoint by literal IP (169.254.169.254)", async () => {
    await assert.rejects(
      () => docsFetch("http://169.254.169.254/latest/meta-data/", { fetchImpl: makeFetch() }),
      (err: unknown) => err instanceof DocsFetchError && err.code === "bad-host",
    );
  });

  test("rejects loopback by literal IP (127.0.0.1)", async () => {
    await assert.rejects(
      () => docsFetch("http://127.0.0.1:6379/info", { fetchImpl: makeFetch() }),
      (err: unknown) => err instanceof DocsFetchError && err.code === "bad-host",
    );
  });

  test("rejects RFC1918 10.x literal", async () => {
    await assert.rejects(
      () => docsFetch("http://10.0.0.5/", { fetchImpl: makeFetch() }),
      (err: unknown) => err instanceof DocsFetchError && err.code === "bad-host",
    );
  });

  test("rejects RFC1918 192.168.x literal", async () => {
    await assert.rejects(
      () => docsFetch("http://192.168.1.1/", { fetchImpl: makeFetch() }),
      (err: unknown) => err instanceof DocsFetchError && err.code === "bad-host",
    );
  });

  test("rejects RFC1918 172.16-31 literal", async () => {
    await assert.rejects(
      () => docsFetch("http://172.20.10.1/", { fetchImpl: makeFetch() }),
      (err: unknown) => err instanceof DocsFetchError && err.code === "bad-host",
    );
  });

  test("rejects IPv6 loopback", async () => {
    await assert.rejects(
      () => docsFetch("http://[::1]/", { fetchImpl: makeFetch() }),
      (err: unknown) => err instanceof DocsFetchError && err.code === "bad-host",
    );
  });

  test("rejects mid-chain redirect to metadata endpoint", async () => {
    let hop = 0;
    const fetchImpl: typeof fetch = async () => {
      hop++;
      if (hop === 1) {
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/" },
        });
      }
      return new Response("leaked", { status: 200 });
    };
    await assert.rejects(
      () => docsFetch("http://8.8.8.8/r", { fetchImpl }),
      (err: unknown) => err instanceof DocsFetchError && err.code === "bad-host",
    );
  });
});
