export class NotImplementedInPhase1 extends Error {
  readonly kind = 'NotImplementedInPhase1';

  constructor(feature: string) {
    super(`${feature} is deferred to Phase 2. See docs/vision.md § Scope: Phase 1.`);
    this.name = 'NotImplementedInPhase1';
  }
}
