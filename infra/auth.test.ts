import { readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  assertRedirectUriRegistered,
  buildCallbackUrls,
  buildLogoutUrls,
  createAuth,
  type CreateAuthInput,
} from "./auth";

// Exercises the real `createAuth` wiring logic against hand-built fakes for
// the `sst`/`aws`/`$app`/`$interpolate` globals SST's CLI would otherwise
// inject — same rationale as `queues.test.ts`'s `attachWorkers` suite: this
// package has no runtime `sst` object outside `sst dev`/`sst deploy`.
class FakeCognitoUserPoolClient {
  readonly id = "fake-client-id";
  readonly capturedTransformArgs: Record<string, unknown> = {};

  constructor(
    readonly name: string,
    args: { transform?: { client?: (transformArgs: Record<string, unknown>) => undefined } },
  ) {
    args.transform?.client?.(this.capturedTransformArgs);
  }
}

class FakeCognitoUserPool {
  readonly id = "fake-user-pool-id";

  constructor(
    readonly name: string,
    readonly args: unknown,
  ) {}

  addClient(
    name: string,
    args: { transform?: { client?: (transformArgs: Record<string, unknown>) => undefined } },
  ): FakeCognitoUserPoolClient {
    return new FakeCognitoUserPoolClient(name, args);
  }
}

class FakeUserPoolDomain {
  readonly domain: string;

  constructor(
    readonly name: string,
    args: { domain: string; userPoolId: string },
  ) {
    this.domain = args.domain;
  }
}

function fakeInterpolate(strings: TemplateStringsArray, ...values: unknown[]): string {
  return strings.reduce((acc, str, i) => acc + str + (i < values.length ? String(values[i]) : ""), "");
}

function setStage(stage: string): void {
  (globalThis as Record<string, unknown>)["$app"] = { stage, name: "keki" };
}

beforeAll(() => {
  (globalThis as Record<string, unknown>)["sst"] = { aws: { CognitoUserPool: FakeCognitoUserPool } };
  (globalThis as Record<string, unknown>)["aws"] = {
    cognito: { UserPoolDomain: FakeUserPoolDomain },
    getRegionOutput: () => ({ name: "us-west-2" }),
  };
  (globalThis as Record<string, unknown>)["$interpolate"] = fakeInterpolate;
});

beforeEach(() => {
  setStage("dev");
});

function buildAuth(appBaseUrl: string, hostedUiDomainPrefix = "keki-dev"): {
  client: FakeCognitoUserPoolClient;
  args: Record<string, unknown>;
  auth: ReturnType<typeof createAuth>;
} {
  const input: CreateAuthInput = { hostedUiDomainPrefix, appBaseUrl };
  const auth = createAuth(input);
  const client = auth.client as unknown as FakeCognitoUserPoolClient;
  return { client, args: client.capturedTransformArgs, auth };
}

describe("createAuth", () => {
  it("enables the OAuth flow toggle (test 1)", () => {
    const { args } = buildAuth("https://dev.example.com");
    expect(args["allowedOauthFlowsUserPoolClient"]).toBe(true);
  });

  it("allows only the code flow, never implicit (test 2)", () => {
    const { args } = buildAuth("https://dev.example.com");
    expect(args["allowedOauthFlows"]).toEqual(["code"]);
    expect(args["allowedOauthFlows"]).not.toContain("implicit");
  });

  it("requests exactly openid, email, and profile (test 3)", () => {
    const { args } = buildAuth("https://dev.example.com");
    expect(args["allowedOauthScopes"]).toEqual(["openid", "email", "profile"]);
  });

  it("generates no client secret (test 4)", () => {
    const { args } = buildAuth("https://dev.example.com");
    expect(args["generateSecret"]).toBeFalsy();
  });

  it("registers the app's /auth/callback as the callback URL, with no trailing slash (test 5)", () => {
    const { auth } = buildAuth("https://dev.example.com");
    expect(auth.redirectUri).toBe("https://dev.example.com/auth/callback");
  });

  it("registers the logout URL (test 6)", () => {
    const { args, auth } = buildAuth("https://dev.example.com");
    expect(args["logoutUrls"]).toContain(auth.signOutUri);
  });

  it("supports only the Cognito identity provider (test 7)", () => {
    const { args } = buildAuth("https://dev.example.com");
    expect(args["supportedIdentityProviders"]).toEqual(["COGNITO"]);
  });

  it("registers the localhost callback outside production (test 8)", () => {
    setStage("dev");
    const { args } = buildAuth("https://dev.example.com");
    expect(args["callbackUrls"]).toContain("http://localhost:3000/auth/callback");
  });

  it("omits any localhost callback in production (test 9)", () => {
    setStage("production");
    const { args } = buildAuth("https://keki.example.com");
    const callbackUrls = args["callbackUrls"] as string[];
    expect(callbackUrls.some((url) => url.includes("localhost"))).toBe(false);
  });

  it("refuses a non-localhost http callback rather than deploying (test 10)", () => {
    setStage("production");
    expect(() => buildAuth("http://keki.example.com")).toThrow(/must use https/);
  });

  it("exports a well-formed hosted-UI base URL (test 11)", () => {
    const { auth } = buildAuth("https://dev.example.com", "keki-dev");
    expect(auth.hostedUiBaseUrl).toMatch(/^https:\/\//);
    expect(auth.hostedUiBaseUrl).toContain(".auth.");
    expect(auth.hostedUiBaseUrl).toContain(".amazoncognito.com");
  });
});

describe("buildCallbackUrls / buildLogoutUrls", () => {
  it("throws for a non-localhost http base URL regardless of stage", () => {
    expect(() => buildCallbackUrls("http://example.com", "dev")).toThrow(/must use https/);
    expect(() => buildLogoutUrls("http://example.com", "dev")).toThrow(/must use https/);
  });

  it("accepts http only for localhost", () => {
    expect(() => buildCallbackUrls("http://localhost:3000", "dev")).not.toThrow();
  });
});

describe("assertRedirectUriRegistered (test 12)", () => {
  const CALLBACK_URLS = ["https://dev.example.com/auth/callback", "http://localhost:3000/auth/callback"];

  it("does not throw when the redirect URI is registered", () => {
    expect(() => assertRedirectUriRegistered(CALLBACK_URLS[0]!, CALLBACK_URLS)).not.toThrow();
  });

  it("throws when the redirect URI is not registered", () => {
    expect(() => assertRedirectUriRegistered("https://other.example.com/auth/callback", CALLBACK_URLS)).toThrow(
      /not among the Cognito client's registered callback URLs/,
    );
  });
});

describe("docs/environment.md (test 13)", () => {
  it("documents COGNITO_HOSTED_UI_URL, COGNITO_REDIRECT_URI, and COGNITO_SIGN_OUT_URI", () => {
    const docs = readFileSync(new URL("../docs/environment.md", import.meta.url), "utf8");
    expect(docs).toContain("COGNITO_HOSTED_UI_URL");
    expect(docs).toContain("COGNITO_REDIRECT_URI");
    expect(docs).toContain("COGNITO_SIGN_OUT_URI");
  });
});
