import { describe, expect, it, vi } from "vitest";

import { CloudClient } from "../../src/cloud/client.js";

const HTML_NOT_FOUND = "<!DOCTYPE html><html><body>404: This page could not be found.</body></html>";

function htmlResponse(status: number): Response {
  return new Response(HTML_NOT_FOUND, {
    status,
    headers: { "content-type": "text/html; charset=utf-8" }
  });
}

function client(fetchMock: typeof fetch): CloudClient {
  return new CloudClient({
    apiUrl: "http://127.0.0.1:8787",
    accessToken: "project-token",
    fetch: fetchMock
  });
}

describe("cloud HTML error pages", () => {
  it("keeps http_status on an HTML 404 instead of INVALID_CLOUD_RESPONSE", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(404));
    const error = await client(fetchMock).getRunStatus("run-html").then(
      () => {
        throw new Error("expected HTML 404 to fail");
      },
      (caught: unknown) => caught
    );
    expect(error).toMatchObject({
      code: "CLOUD_REQUEST_FAILED",
      details: {
        http_status: 404,
        http_method: "GET",
        http_path: "/v1/relay/runs/run-html"
      }
    });
    expect(error).not.toMatchObject({ code: "INVALID_CLOUD_RESPONSE" });
    expect((error as { message: string }).message).toContain("GET /v1/relay/runs/run-html");
  });

  it("still rejects an HTML 200 as INVALID_CLOUD_RESPONSE", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(200));
    await expect(client(fetchMock).getRunStatus("run-html")).rejects.toMatchObject({
      code: "INVALID_CLOUD_RESPONSE",
      message: "AugmentWorks returned an invalid JSON response."
    });
  });

  it("keeps a billing HTML error body on the existing invalid JSON path", async () => {
    const fetchMock = vi.fn<typeof fetch>(async () => htmlResponse(502));
    await expect(client(fetchMock).getBillingUsage()).rejects.toMatchObject({
      code: "INVALID_CLOUD_RESPONSE",
      message: "AugmentWorks returned an invalid JSON response."
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
