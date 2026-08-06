/// <reference path="./.sst/platform/config.d.ts" />

// This file is the only place `infra/`'s ambient SST/Pulumi globals need to
// be the *real* ones — see `infra/sst-types.d.ts` for why the rest of the
// `infra` package uses a local stand-in instead of this reference.
//
// SST evaluates `app()` before the platform globals exist, so this file may
// not carry top-level imports. `infra/index` is pulled in with a dynamic
// import inside `run()`, which is the only point where those globals are
// available. A static import here fails at startup with "Your sst.config.ts
// has top level imports - this is not allowed."

export default $config({
  app(input) {
    return {
      name: "keki",
      home: "aws",
      region: "us-east-1",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
    };
  },
  async run() {
    const { createInfra } = await import("./infra/index");
    return createInfra();
  },
});
