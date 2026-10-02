import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  subscriberHash,
  upsertListMember,
  mockUpsertListMember,
  MailchimpApiError,
  isRetryableMailchimpError,
  describeMailchimpError,
  memberUrl,
  audienceUrl,
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
    fetchMock.mockResolvedValueOnce(json({ id: "member-1", web_id: 123456 }));

    const result = await upsertListMember(CONFIG, {
      email: "jane@example.com",
      mergeFields: { FNAME: "Jane" },
    });

    expect(result).toEqual({ memberId: "member-1", webId: 123456 });
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
    fetchMock.mockResolvedValueOnce(json({ id: "member-1", web_id: 123456 }));
    await upsertListMember(CONFIG, { email: "jane@example.com", statusIfNew: "pending" });
    expect(JSON.parse(fetchMock.mock.calls[0][1].body).status_if_new).toBe("pending");
  });

  it("adds tags via the tags endpoint when given", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "member-1", web_id: 123456 })).mockResolvedValueOnce(new Response(null, { status: 204 }));

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
    expect(err.readableReason).toBe("Member In Compliance State: jane@example.com is unsubscribed");
  });

  it("names the server prefix when its host doesn't resolve (Cloudflare 530), and doesn't retry it", async () => {
    fetchMock.mockResolvedValueOnce(new Response("error code: 1016", { status: 530 }));

    const err = await upsertListMember({ ...CONFIG, serverPrefix: "us-14" }, { email: "jane@example.com" }).catch(
      (e) => e
    );
    expect(err).toBeInstanceOf(MailchimpApiError);
    expect(err.status).toBe(530);
    expect(err.readableReason).toMatch(/server prefix "us-14" doesn't exist/);
    expect(isRetryableMailchimpError(err)).toBe(false);
  });

  it("falls back to the HTTP status when there's no problem body or status text", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<html>oops</html>", { status: 502, statusText: "" }));

    const err = await upsertListMember(CONFIG, { email: "jane@example.com" }).catch((e) => e);
    expect(err.message).toBe("Mailchimp 502: Unexpected response from Mailchimp (HTTP 502)");
  });
});

describe("mockUpsertListMember", () => {
  it("never calls Mailchimp, and returns the real subscriber hash as memberId", async () => {
    const result = await mockUpsertListMember(CONFIG, { email: "Jane@Example.com", tags: ["x"] });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ memberId: "9e26471d35a78862c17e467d87cddedf", webId: 0 });
  });
});

describe("isRetryableMailchimpError", () => {
  it("does not retry permanent 4xx", () => {
    expect(isRetryableMailchimpError(new MailchimpApiError(400, "bad"))).toBe(false);
    expect(isRetryableMailchimpError(new MailchimpApiError(401, "unauthorized"))).toBe(false);
  });

  it("retries 429, 5xx and non-Mailchimp errors (network, timeout)", () => {
    expect(isRetryableMailchimpError(new MailchimpApiError(429, "slow down"))).toBe(true);
    expect(isRetryableMailchimpError(new MailchimpApiError(503, "down"))).toBe(true);
    expect(isRetryableMailchimpError(new TypeError("fetch failed"))).toBe(true);
  });
});

describe("describeMailchimpError", () => {
  it("uses Mailchimp's own reason, without the status prefix", () => {
    expect(describeMailchimpError(new MailchimpApiError(400, "Invalid Resource: bad email"))).toBe(
      "Invalid Resource: bad email"
    );
  });

  it("gives a readable reason for timeouts and network errors", () => {
    expect(describeMailchimpError(new DOMException("aborted", "AbortError"))).toBe("Mailchimp didn't respond in time");
    expect(describeMailchimpError(new TypeError("fetch failed"))).toBe("Couldn't reach Mailchimp");
  });
});

describe("result links", () => {
  it("links to the member on the account's datacenter", () => {
    expect(memberUrl(CONFIG, 123456)).toBe("https://us21.admin.mailchimp.com/lists/members/view?id=123456");
  });

  it("falls back to the audiences page", () => {
    expect(audienceUrl(CONFIG)).toBe("https://us21.admin.mailchimp.com/lists/");
  });
});
