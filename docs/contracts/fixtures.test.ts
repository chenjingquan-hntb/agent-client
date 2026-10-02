/**
 * Offline contract examples ONLY. No HTTP, no production modules, no Cargo.
 * Rust include_str uses the same body fixtures, but these tests do not execute Rust.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

type Field = { name: string; rust_type: string; default_on_missing: boolean; null_to_default: boolean; lenient_strings: boolean };
type WireObject = Record<string, unknown>;
const load = (name: string) => JSON.parse(readFileSync(new URL(name, import.meta.url), "utf8"));
const dto = load("./client-dto-v1.json");
const calls = load("./calls-v1.json");
const evidence = load("./source-evidence.json");
const account = load("./fixtures/account-golden.json");
const pay = load("./fixtures/pay-golden.json");
const native = load("./fixtures/rc37-golden.json");
const boundary = load("./fixtures/boundary-cases.json");
const bodyFixture = (name: string) => load("./fixtures/" + name);
const isObject = (value: unknown): value is WireObject => value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown) => typeof value === "number" && Number.isSafeInteger(value);

// Reference specification, not a proposed native-auth adapter.
function strictEnvelope(body: unknown): unknown {
  if (!isObject(body) || !Object.hasOwn(body, "code") || !integer(body.code)) throw new Error("numeric code required");
  if (body.code !== 0) throw new Error("account business rejection");
  if (!Object.hasOwn(body, "data") || body.data == null) throw new Error("non-null data required");
  return body.data;
}
function strictRefresh(body: unknown): WireObject {
  const data = strictEnvelope(body);
  if (!isObject(data)) throw new Error("token pair object required");
  for (const field of ["access_token", "refresh_token"]) {
    if (typeof data[field] !== "string" || data[field] === "") throw new Error("nonempty token required");
  }
  if (!integer(data.expires_in) || (data.expires_in as number) <= 0) throw new Error("positive relative expiry required");
  return data;
}
function sanitizedParse(text: string): unknown {
  try { return JSON.parse(text); } catch { throw new Error("invalid JSON response"); }
}
// Safe-integer fixture subset of Rust i64/u64; not a serde-equivalence proof.
function validateType(type: string, value: unknown): void {
  if (type === "serde_json::Value" || type === "raw-group-status") return;
  if (type.startsWith("Option<")) {
    if (value == null) return;
    return validateType(type.slice(7, -1), value);
  }
  if (type.startsWith("Vec<")) {
    if (!Array.isArray(value)) throw new Error("array required for " + type);
    for (const item of value) validateType(type.slice(4, -1), item);
    return;
  }
  const generic = type.match(/^Paginated<(.+)>$/);
  if (generic) {
    if (!isObject(value)) throw new Error("page required");
    if (value.items != null) validateType("Vec<" + generic[1] + ">", value.items);
    if (value.total !== undefined) validateType("i64", value.total);
    return;
  }
  if (type === "String") { if (typeof value !== "string") throw new Error("string required"); return; }
  if (type === "bool") { if (typeof value !== "boolean") throw new Error("boolean required"); return; }
  if (["i64", "u64", "u32"].includes(type)) {
    if (!integer(value) || (type.startsWith("u") && (value as number) < 0)) throw new Error("integer required");
    return;
  }
  if (type === "f64") { if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("number required"); return; }
  if (type === "ValidityUnit") { if (typeof value !== "string") throw new Error("unit string required"); return; }
  const shape = dto.types[type];
  if (!shape || !isObject(value)) throw new Error("DTO object required: " + type);
  for (const field of shape.fields as Field[]) {
    if (!Object.hasOwn(value, field.name)) {
      if (field.default_on_missing) continue;
      throw new Error("missing DTO field: " + field.name);
    }
    const fieldValue = value[field.name];
    if (field.null_to_default && fieldValue === null) continue;
    if (field.lenient_strings) continue; // Source lenient_strings intentionally accepts non-arrays too.
    validateType(field.rust_type, fieldValue);
  }
}
function normalizeHealth(raw: WireObject) {
  const summary = isObject(raw.summary) ? raw.summary : {};
  const group = isObject(raw.group) ? raw.group : {};
  const str = (...xs: unknown[]) => xs.find(x => typeof x === "string") as string | undefined;
  const num = (...xs: unknown[]) => xs.find(x => typeof x === "number") as number | undefined;
  return {
    group_id: num(raw.group_id, summary.group_id, group.id) ?? 0,
    group_name: str(raw.group_name, group.name) || str(summary.group_name) || "",
    latest_status: str(raw.latest_status, summary.latest_status) ?? "",
    stable_status: str(raw.stable_status, summary.stable_status) ?? "",
    latency_ms: num(raw.latency_ms, summary.latency_ms) ?? null,
    availability_24h: num(raw.availability_24h, raw.availability24) ?? null,
    availability_7d: num(raw.availability_7d, raw.availability7d) ?? null,
  };
}
function collectPageIds(pages: WireObject[]): number[] {
  const found = new Set<number>();
  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    if (page.page !== i + 1 || !integer(page.total) || !Array.isArray(page.items)) throw new Error("bad pagination");
    if (page.items.length === 0 && found.size < (page.total as number)) throw new Error("incomplete pagination");
    const before = found.size;
    for (const item of page.items) {
      if (!isObject(item) || !integer(item.id)) throw new Error("bad item id");
      found.add(item.id as number);
    }
    if (found.size >= (page.total as number)) return [...found];
    if (found.size === before) throw new Error("stalled pagination");
  }
  throw new Error("incomplete pagination");
}

describe("frozen source attribution and complete original account/pay inventory", () => {
  test("server tag is rc.37, never develop; runtime is NOT_RUN", () => {
    expect(evidence.server.tag).toBe("v1.0.0-rc.37");
    expect(evidence.server.commit).toBe("385d2dfd10d821b25c8a6766bd16eea248cb1652");
    expect(evidence.runtime).toBe("NOT_RUN");
    for (const side of [evidence.server, evidence.client]) {
      for (const file of side.files) expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
    }
  });
  test("16 account and 6 pay golden cases cover their frozen call IDs", () => {
    const ids = calls.calls.map((c: WireObject) => c.id);
    expect(new Set(ids).size).toBe(35);
    for (const [prefix, suite, count] of [["A", account, 16], ["P", pay, 6]] as const) {
      expect(suite.cases.length).toBe(count);
      expect(suite.cases.map((c: WireObject) => c.id).sort()).toEqual(ids.filter((id: string) => id.startsWith(prefix)).sort());
      for (const c of suite.cases) {
        const route = calls.calls.find((r: WireObject) => r.id === c.id);
        expect(c.request.method).toBe(route.method);
        expect(c.request.url).toBe("https://example.invalid" + route.path);
        expect(c.request.body).toEqual(route.request);
        expect(c.dto).toBe(route.dto);
      }
    }
  });
});

describe("original numeric-code account target DTOs", () => {
  for (const c of account.cases) test(c.id + " " + c.dto, () => {
    const data = strictEnvelope(c.response.body);
    validateType(c.dto, data);
    if (c.id === "A06") strictRefresh(c.response.body);
  });
  test("flat/nested group health aliases preserve top-level availability precedence", () => {
    const items = account.cases.find((c: WireObject) => c.id === "A10").response.body.data;
    expect(normalizeHealth(items[0]).availability_24h).toBe(99.9);
    expect(normalizeHealth(items[1]).group_id).toBe(102);
    expect(normalizeHealth(items[1]).stable_status).toBe("healthy");
    expect(normalizeHealth({ summary: { availability_24h: 75 } }).availability_24h).toBeNull();
  });
  test("null containers retain original null_to_default tolerance, price null is not zero", () => {
    validateType("User", boundary.nullable_user);
    validateType("Paginated<ApiKey>", boundary.nullable_page);
    validateType("Price", boundary.null_catalog_price);
    expect(boundary.null_catalog_price.input_per_mtok_usd).toBeNull();
  });
  test("native role/status number cannot decode into original String fields", () => {
    expect(() => validateType("User", native.cases[0].body.data)).toThrow();
  });
});

describe("required code and relative refresh boundaries (shared raw Rust fixtures)", () => {
  test("refresh-valid.json", () => expect(strictRefresh(bodyFixture("refresh-valid.json")).expires_in).toBe(900));
  for (const name of ["native-refresh-success.json", "native-self-success.json", "refresh-missing-fields.json", "refresh-empty-token.json", "refresh-empty-refresh-token.json", "refresh-nonpositive-expiry.json", "refresh-negative-expiry.json", "refresh-string-expiry.json"]) {
    test("reject " + name, () => expect(() => strictRefresh(bodyFixture(name))).toThrow());
  }
  for (const c of boundary.bad_envelopes) test("reject envelope: " + c.name, () => expect(() => strictEnvelope(c.body)).toThrow());
  for (const c of boundary.bad_refresh) test("reject refresh: " + c.name, () => expect(() => strictRefresh(c.body)).toThrow());
  test("business refusal and null data fail, including unit-returning account calls", () => {
    expect(() => strictEnvelope(bodyFixture("envelope-business-error.json"))).toThrow();
    expect(() => strictEnvelope(bodyFixture("envelope-empty-data.json"))).toThrow();
    expect(() => strictEnvelope({ code: 0 })).toThrow();
    expect(() => strictEnvelope(bodyFixture("native-auth-error.json"))).toThrow();
  });
  test("malformed JSON diagnostics never echo the supplied body (offline specification only)", () => {
    const marker = "FIXTURE_ONLY_SENSITIVE_PAYLOAD";
    let message = "";
    try { sanitizedParse("{\"token\":\"" + marker); } catch (error) { message = String(error); }
    expect(message).toContain("invalid JSON response");
    expect(message).not.toContain(marker);
  });
  for (const c of native.cases) test("rc.37 wire shape is NOT numeric-code client-api-v1: " + c.id, () => expect(() => strictEnvelope(c.body)).toThrow());
});

describe("key identity, pagination and error distinctions", () => {
  test("enumerate all token pages; fail on empty/stalled pages rather than certify completeness", () => {
    expect(collectPageIds(boundary.pagination.pages)).toEqual(boundary.pagination.expected_ids);
    expect(() => collectPageIds(boundary.pagination.stalled_pages)).toThrow();
    expect(() => collectPageIds([boundary.pagination.pages[0]])).toThrow();
  });
  test("native token creation is not an ApiKey; listed keys are masked; plaintext retrieval is separate", () => {
    const created = native.cases.find((c: WireObject) => c.id === "native-token-created").body;
    const listed = native.cases.find((c: WireObject) => c.id === "native-token-list").body.data.items[0];
    const retrieved = native.cases.find((c: WireObject) => c.id === "native-token-key").body.data;
    expect(created.data).toBeUndefined();
    expect(listed.key).toContain("**");
    expect(retrieved.key).toBe("FIXTURE_ONLY_MODEL_KEY");
    expect(listed.group).toBe("fixture-standard");
    expect(listed.status).toBe(1);
  });
  test("numeric group bindings are explicit, unique and do not fabricate an auto multiplier", () => {
    const bindings = boundary.pagination.group_bindings;
    expect(new Set(bindings.map((b: WireObject) => b.client_group_id)).size).toBe(bindings.length);
    expect(new Set(bindings.map((b: WireObject) => b.native_group)).size).toBe(bindings.length);
    const groups = native.cases.find((c: WireObject) => c.id === "native-groups").body.data;
    expect(typeof groups.auto.ratio).toBe("string");
    expect(bindings.find((b: WireObject) => b.native_group === "missing")).toBeUndefined();
  });
  for (const c of boundary.account_error_cases) test("error category " + c.status + "/" + c.reason, () => {
    const authReasons = ["REFRESH_TOKEN_INVALID", "REFRESH_TOKEN_EXPIRED", "REFRESH_TOKEN_REUSED", "TOKEN_REVOKED", "SESSION_BINDING_MISMATCH", "USER_NOT_ACTIVE"];
    expect([401, 403].includes(c.status) || authReasons.includes(c.reason)).toBe(c.auth_rejection);
  });
});

describe("payment stays plain JSON and separates account/order authorization", () => {
  for (const c of pay.cases) test(c.id + " " + c.dto, () => {
    const body = c.response.body;
    expect(Object.hasOwn(body, "code")).toBe(false);
    if (["PayOrder", "OrderStatus"].includes(c.dto)) validateType(c.dto, body);
    if (c.id === "P01") expect(body.user.id).toBeGreaterThan(0);
    if (c.id === "P02") validateType("MethodLimit", body.config.methodLimits["fixture-method"]);
    if (c.id === "P03") for (const plan of body.plans) { validateType("SubscriptionPlan", plan); expect(plan.id).not.toBe(""); expect(plan.groupId).toBeGreaterThan(0); }
    if (c.id === "P04") { expect(body.orderId).not.toBe(""); expect(body.statusAccessToken).toBe("FIXTURE_ONLY_ORDER_STATUS"); }
    if (c.id === "P05") { expect(c.request.url).toContain("access_token=FIXTURE_ONLY_ORDER_STATUS"); expect(c.request.headers.Authorization).toBeUndefined(); }
  });
  test("Bearer read fallback is restricted to original 400/401 semantics, never arbitrary retry", () => {
    for (const status of boundary.pay_fallback.initial_statuses) expect([400, 401].includes(status)).toBe(true);
    for (const status of boundary.pay_fallback.no_fallback_statuses) expect([400, 401].includes(status)).toBe(false);
  });
  for (const c of boundary.pay_statuses) test("order state " + c.status, () => {
    expect(["FAILED", "CANCELLED", "EXPIRED", "COMPLETED"].includes(c.status.toUpperCase())).toBe(c.terminal);
    expect(c.rechargeSuccess || c.status.toLowerCase() === "completed").toBe(c.settled);
  });
});
