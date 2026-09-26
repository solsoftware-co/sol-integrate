import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  subscriberHash,
  upsertListMember,
  MailchimpApiError,
  isRetryableMailchimpError,
} from "../../../src/lib/mailchimp.js";

const CONFIG = { apiKey: "abc123-us21", listId: "list42", serverPrefix: "us21" };

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("subscriberHash", () => {
  it("is the MD5 of the lowercased email", async () => {
    expect(await subscriberHash("Jane@Example.com")).toBe("9e26471d35a78862c17e467d87cddedf");
  });
});

describe("upsertListMember", () => {
  it("PUTs the member on the right datacenter with basic auth", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "member-1" }));

    const result = await upsertListMember(CONFIG, {
      email: "jane@example.com",
      mergeFields: { FNAME: "Jane" },
    });

    expect(result).toEqual({ memberId: "member-1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://us21.api.mailchimp.com/3.0/lists/list42/members/9e26471d35a78862c17e467d87cddedf");
    expect(init.method).toBe("PUT");
    expect(init.headers.Authorization).toBe(`Basic ${btoa("sol:abc123-us21")}`);
    expect(JSON.parse(init.body)).toEqual({
      email_address: "jane@example.com",
      status_if_new: "subscribed",
      merge_fields: { FNAME: "Jane" },
    });
  });

  it("honours statusIfNew for double opt-in", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "member-1" }));
    await upsertListMember(CONFIG, { email: "jane@example.com", statusIfNew: "pending" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).status_if_new).toBe("pending");
  });

  it("adds tags via the tags endpoint when given", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "member-1" })).mockResolvedValueOnce(new Response(null, { status: 204 }));

    await upsertListMember(CONFIG, { email: "jane@example.com", tags: ["website", "spring-promo"] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [url, init] = fetchMock.mock.calls[1];
    expect(url).toMatch(/\/members\/9e26471d35a78862c17e467d87cddedf\/tags$/);
    expect(JSON.parse(init.body)).toEqual({
      tags: [
        { name: "website", status: "active" },
        { name: "spring-promo", status: "active" },
      ],
    });
  });

  it("throws a MailchimpApiError carrying Mailchimp's problem detail", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ title: "Member In Compliance State", detail: "jane@example.com is unsubscribed", status: 400 }, 400)
    );

    const err = await upsertListMember(CONFIG, { email: "jane@example.com" }).catch((e) => e);
    expect(err).toBeInstanceOf(MailchimpApiError);
    expect(err.status).toBe(400);
    expect(err.message).toContain("Member In Compliance State");
  });
});

describe("isRetryableMailchimpError", () => {
  it("does not retry permanent 4xx", () => {
    expect(isRetryableMailchimpError(new MailchimpApiError("bad", 400))).toBe(false);
    expect(isRetryableMailchimpError(new MailchimpApiError("unauthorized", 401))).toBe(false);
  });

  it("retries 429, 5xx and non-Mailchimp errors (network, timeout)", () => {
    expect(isRetryableMailchimpError(new MailchimpApiError("slow down", 429))).toBe(true);
    expect(isRetryableMailchimpError(new MailchimpApiError("down", 503))).toBe(true);
    expect(isRetryableMailchimpError(new TypeError("fetch failed"))).toBe(true);
  });
});
