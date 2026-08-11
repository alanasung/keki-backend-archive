import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildSchedulerPolicyDocument, buildSchedulerTrustPolicy } from "./scheduler";
import { SECRET_NAMES } from "./secrets";
import { DOCUMENT_BUCKET_CONFIG } from "./storage";
import { WEB_ENV_MAPPING } from "./web";

const infraDir = fileURLToPath(new URL(".", import.meta.url));

function readInfraSource(filename: string): string {
  return readFileSync(new URL(filename, import.meta.url), "utf8");
}

describe("SECRET_NAMES", () => {
  it("declares exactly the eleven required secrets", () => {
    expect([...SECRET_NAMES].sort()).toEqual(
      [
        "NeonPooledUrl",
        "NeonDirectUrl",
        "SquareAccessToken",
        "SquareEnvironment",
        "SquareWebhookSignatureKey",
        "SquareNotificationUrl",
        "CartCookieSecret",
        "AppBaseUrl",
        "KlaviyoApiKey",
        "WaiverProviderApiKey",
        "KioskDeviceToken",
      ].sort(),
    );
  });

  // WS-11 test 1: the four secrets this workstream adds.
  it("includes the four WS-11 secrets", () => {
    for (const name of ["SquareEnvironment", "SquareNotificationUrl", "CartCookieSecret", "AppBaseUrl"]) {
      expect(SECRET_NAMES).toContain(name);
    }
  });

  // WS-11 test 2: the declared-once rule — no secret is redeclared under a
  // second name.
  it("declares no name twice", () => {
    expect(new Set(SECRET_NAMES).size).toBe(SECRET_NAMES.length);
  });
});

describe("no secret value is committed", () => {
  const NEON_URL_PATTERN = /postgres(?:ql)?:\/\/[^\s"'`]*@[^\s"'`]*neon\.tech/i;
  const AWS_ACCESS_KEY_PATTERN = /\b(AKIA|ASIA)[0-9A-Z]{16}\b/;
  const SQUARE_TOKEN_PATTERN = /\bEAAA[0-9A-Za-z_-]{20,}\b/;

  const tsFiles = readdirSync(infraDir).filter((name) => name.endsWith(".ts"));

  it.each(tsFiles)("%s contains no literal Neon URL, AWS key, or Square token", (filename) => {
    const source = readInfraSource(filename);
    expect(source).not.toMatch(NEON_URL_PATTERN);
    expect(source).not.toMatch(AWS_ACCESS_KEY_PATTERN);
    expect(source).not.toMatch(SQUARE_TOKEN_PATTERN);
  });
});

describe("infra/web.ts environment mapping", () => {
  it("maps the pooled and direct connection strings to distinct secrets", () => {
    expect(WEB_ENV_MAPPING.DATABASE_URL_POOLED).toBe("NeonPooledUrl");
    expect(WEB_ENV_MAPPING.DATABASE_URL_DIRECT).toBe("NeonDirectUrl");
    expect(WEB_ENV_MAPPING.DATABASE_URL_POOLED).not.toBe(WEB_ENV_MAPPING.DATABASE_URL_DIRECT);
  });

  it("links exactly the seven application variables, and none of the function-scoped ones", () => {
    expect(Object.keys(WEB_ENV_MAPPING).sort()).toEqual(
      [
        "DATABASE_URL_POOLED",
        "DATABASE_URL_DIRECT",
        "COGNITO_USER_POOL_ID",
        "COGNITO_CLIENT_ID",
        "KIOSK_DEVICE_TOKEN",
        "CART_COOKIE_SECRET",
        "APP_BASE_URL",
      ].sort(),
    );
    expect(Object.keys(WEB_ENV_MAPPING)).not.toContain("SQUARE_WEBHOOK_SIGNATURE_KEY");
    expect(Object.keys(WEB_ENV_MAPPING)).not.toContain("SQUARE_ACCESS_TOKEN");
    expect(Object.keys(WEB_ENV_MAPPING)).not.toContain("KEKI_ALLOW_NOOP_PROVIDERS");
    // Reserved Lambda key — CreateFunction rejects it; Lambda injects it.
    expect(Object.keys(WEB_ENV_MAPPING)).not.toContain("AWS_REGION");
  });

  // WS-11 test 7: the web function receives cart and base-URL configuration.
  it("maps CART_COOKIE_SECRET and APP_BASE_URL to their secrets", () => {
    expect(WEB_ENV_MAPPING.CART_COOKIE_SECRET).toBe("CartCookieSecret");
    expect(WEB_ENV_MAPPING.APP_BASE_URL).toBe("AppBaseUrl");
  });

  // WS-11 test 8: no secret is exposed as NEXT_PUBLIC_.
  it("exposes no mapped key as NEXT_PUBLIC_", () => {
    for (const key of Object.keys(WEB_ENV_MAPPING)) {
      expect(key.startsWith("NEXT_PUBLIC_")).toBe(false);
    }
  });

  // WS-11 test 9: AWS_REGION remains unset — Phase 1's reserved-key fix
  // stays intact.
  it("still does not set AWS_REGION", () => {
    expect(Object.keys(WEB_ENV_MAPPING)).not.toContain("AWS_REGION");
  });
});

describe("DOCUMENT_BUCKET_CONFIG", () => {
  it("is private: full public-access block, versioning, and encryption, no public exposure", () => {
    expect(DOCUMENT_BUCKET_CONFIG.publicAccess).toBe(false);
    expect(DOCUMENT_BUCKET_CONFIG.blockPublicAccess).toBe(true);
    expect(DOCUMENT_BUCKET_CONFIG.versioning).toBe(true);
    expect(DOCUMENT_BUCKET_CONFIG.encryption).toBe(true);
    expect(DOCUMENT_BUCKET_CONFIG.websiteConfiguration).toBe(false);
    expect(DOCUMENT_BUCKET_CONFIG.corsRules).toEqual([]);
  });
});

describe("scheduler execution role", () => {
  it("trusts only the EventBridge Scheduler service principal", () => {
    const policy = buildSchedulerTrustPolicy() as { Statement: Array<{ Principal: { Service: string } }> };
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]?.Principal.Service).toBe("scheduler.amazonaws.com");
  });

  it("grants only sqs:SendMessage against the ScheduledTaskQueue ARN, never sqs:* or *", () => {
    const arn = "arn:aws:sqs:us-east-1:111111111111:keki-dev-ScheduledTaskQueue";
    const policy = buildSchedulerPolicyDocument(arn) as {
      Statement: Array<{ Action: string; Resource: string }>;
    };
    expect(policy.Statement).toHaveLength(1);
    expect(policy.Statement[0]?.Action).toBe("sqs:SendMessage");
    expect(policy.Statement[0]?.Resource).toBe(arn);
    expect(policy.Statement[0]?.Action).not.toBe("sqs:*");
    expect(policy.Statement[0]?.Resource).not.toBe("*");
  });
});

describe("infra/auth.ts (no Cognito group authority)", () => {
  it("declares no Cognito group resource", () => {
    const source = readInfraSource("auth.ts");
    expect(source).not.toMatch(/UserGroup/);
    expect(source).not.toMatch(/CognitoIdentityProvider[Gg]roup/);
  });
});

describe("production stage protection", () => {
  it("sst.config.ts sets protect and retain only for the production stage", () => {
    const source = readFileSync(new URL("../sst.config.ts", import.meta.url), "utf8");
    expect(source).toMatch(/protect:\s*input\?\.stage === ["']production["']/);
    expect(source).toMatch(/removal:\s*input\?\.stage === ["']production["']\s*\?\s*["']retain["']/);
  });
});
