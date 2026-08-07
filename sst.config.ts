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
      // Must stay in lockstep with AWS_REGION in infra/index.ts — this value
      // places the resources, that one tells the app runtime where Cognito
      // lives. They cannot share a constant because this file may not import
      // infra/ at top level (see above).
      region: "us-west-2",
      removal: input?.stage === "production" ? "retain" : "remove",
      protect: input?.stage === "production",
    };
  },
  async run() {
    // Production deploys are git-tracked: they run only from GitHub Actions
    // (deploy.yml, triggered by a v* tag). This guard lives in run(), not
    // app(), so laptop `sst secret set --stage production` keeps working —
    // only operations that evaluate the program (deploy/dev/diff/refresh/
    // remove) are refused. KEKI_ALLOW_LOCAL_PROD_DEPLOY=1 is the documented
    // break-glass for deploying a known-good tag while Actions is down.
    if (
      $app.stage === "production" &&
      process.env.GITHUB_ACTIONS !== "true" &&
      process.env.KEKI_ALLOW_LOCAL_PROD_DEPLOY !== "1"
    ) {
      throw new Error(
        "Production deploys run from GitHub Actions only (push a v* tag). " +
          "Break-glass: KEKI_ALLOW_LOCAL_PROD_DEPLOY=1 sst deploy --stage production",
      );
    }
    const { createInfra } = await import("./infra/index");
    return createInfra();
  },
});
