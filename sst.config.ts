/// <reference path="./.sst/platform/config.d.ts" />

// This file is the only place `infra/`'s ambient SST/Pulumi globals need to
// be the *real* ones — see `infra/sst-types.d.ts` for why the rest of the
// `infra` package uses a local stand-in instead of this reference.
import { createInfra } from "./infra/index";

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
    return createInfra();
  },
});
