// Cognito owns identity only. Postgres (via `@keki/auth`, WS-04) owns the
// `CUSTOMER` / `FRONT_OF_HOUSE` / `MANAGER` / `ADMIN` role assignment, so no
// Cognito group is declared here — a group would invite someone to read it
// as the authoritative role source later.
export const USER_POOL_NAME = "KekiUserPool";
export const USER_POOL_CLIENT_NAME = "KekiWebClient";

export const PASSWORD_POLICY = {
  minimumLength: 12,
  requireLowercase: true,
  requireUppercase: true,
  requireNumbers: true,
  requireSymbols: true,
} as const;

export interface AuthResources {
  userPool: sst.aws.CognitoUserPool;
  client: sst.aws.CognitoUserPoolClient;
  domain: aws.cognito.UserPoolDomain;
}

export function createAuth(hostedUiDomainPrefix: string): AuthResources {
  const userPool = new sst.aws.CognitoUserPool(USER_POOL_NAME, {
    usernames: ["email"],
    transform: {
      userPool: (args) => {
        args.passwordPolicy = { ...PASSWORD_POLICY };
        return undefined;
      },
    },
  });

  const client = userPool.addClient(USER_POOL_CLIENT_NAME);

  // WS-09's sign-in placeholder will eventually redirect through this
  // hosted UI domain; nothing consumes it yet in Phase 1.
  const domain = new aws.cognito.UserPoolDomain(`${USER_POOL_NAME}Domain`, {
    domain: hostedUiDomainPrefix,
    userPoolId: userPool.id,
  });

  return { userPool, client, domain };
}
