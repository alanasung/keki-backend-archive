export class AuthConfigError extends Error {
  readonly kind = 'AuthConfigError' as const;

  constructor(message: string) {
    super(message);
    this.name = 'AuthConfigError';
  }
}

export class InvalidTokenError extends Error {
  readonly kind = 'InvalidTokenError' as const;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'InvalidTokenError';
  }
}

export class ProfileNotFoundError extends Error {
  readonly kind = 'ProfileNotFoundError' as const;

  constructor(cognitoSub: string) {
    super(`No customer profile found for Cognito subject "${cognitoSub}".`);
    this.name = 'ProfileNotFoundError';
  }
}
